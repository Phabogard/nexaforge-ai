import { describe, expect, it } from 'vitest';
import { AgentRuntime, type AgentExecutionContext } from './agent-runtime.js';
import { ActionEngine, signApproval, type ActionApproval } from './action-engine.js';
import { PermissionEngine } from './permission-engine.js';
import { PolicyEngine } from './policy-engine.js';
import { AuditLogger } from './audit-logger.js';

const TEST_SECRET = 'test-secret-key-1234567890';

describe('Agent Runtime & Action Engine Hardening', () => {
  it('enforces all 6 execution limits and abort signal', () => {
    const ctx: AgentExecutionContext = {
      agentId: 'a1',
      agentType: 'PlanningAgent',
      userId: 'u1',
      currentDepth: 1,
      currentIteration: 1,
      currentStep: 1,
      toolCallCount: 1,
      modelCallCount: 1,
      startTime: Date.now()
    };

    expect(() => AgentRuntime.validateLimits(ctx)).not.toThrow();

    // 1. Abort signal
    const abortController = new AbortController();
    abortController.abort();
    expect(() => AgentRuntime.validateLimits({ ...ctx, signal: abortController.signal })).toThrow('AGENT_EXECUTION_CANCELLED');

    // 2. Iterations
    expect(() => AgentRuntime.validateLimits({ ...ctx, currentIteration: 15 })).toThrow('MAX_AGENT_ITERATIONS_EXCEEDED');

    // 3. Steps
    expect(() => AgentRuntime.validateLimits({ ...ctx, currentStep: 30 })).toThrow('MAX_AGENT_STEPS_EXCEEDED');

    // 4. Tool calls
    expect(() => AgentRuntime.validateLimits({ ...ctx, toolCallCount: 25 })).toThrow('MAX_AGENT_TOOL_CALLS_EXCEEDED');

    // 5. Model calls
    expect(() => AgentRuntime.validateLimits({ ...ctx, modelCallCount: 20 })).toThrow('MAX_AGENT_MODEL_CALLS_EXCEEDED');

    // 6. Recursion depth
    expect(() => AgentRuntime.validateLimits({ ...ctx, currentDepth: 5 })).toThrow('MAX_AGENT_RECURSION_DEPTH_EXCEEDED');

    // 7. Duration
    expect(() => AgentRuntime.validateLimits({ ...ctx, startTime: Date.now() - 400000 })).toThrow('MAX_AGENT_DURATION_EXCEEDED');
  });

  it('fails closed when toolExecutor is missing', async () => {
    const permEngine = new PermissionEngine();
    permEngine.grantInMemory('u1', 'web.read');

    const policyEngine = new PolicyEngine();
    const mockAuditRepo = { addAuditLog: async () => ({}) } as any;
    const logger = new AuditLogger(mockAuditRepo);
    const actionEngine = new ActionEngine(permEngine, policyEngine, logger, null, TEST_SECRET);

    const ctx: AgentExecutionContext = {
      agentId: 'agent-browser',
      agentType: 'BrowserAgent',
      userId: 'u1',
      currentDepth: 1,
      currentIteration: 1,
      startTime: Date.now()
    };

    const res = await actionEngine.executeAction(ctx, {
      actionId: 'act-no-executor',
      capability: 'web.read',
      tool: 'fetch_page',
      actionName: 'Fetch page content',
      description: 'Fetch URL',
      params: { url: 'https://example.com' }
    });

    expect(res.success).toBe(false);
    expect(res.status).toBe('failed');
    expect(res.error).toBe('TOOL_EXECUTOR_REQUIRED');
  });

  it('prevents action replay for the same actionId', async () => {
    const permEngine = new PermissionEngine();
    permEngine.grantInMemory('u1', 'web.read');

    const policyEngine = new PolicyEngine();
    const mockAuditRepo = { addAuditLog: async () => ({}) } as any;
    const logger = new AuditLogger(mockAuditRepo);
    const actionEngine = new ActionEngine(permEngine, policyEngine, logger, null, TEST_SECRET);

    const ctx: AgentExecutionContext = {
      agentId: 'agent-browser',
      agentType: 'BrowserAgent',
      userId: 'u1',
      currentDepth: 1,
      currentIteration: 1,
      startTime: Date.now()
    };

    const actionReq = {
      actionId: 'act-replay-test',
      capability: 'web.read' as const,
      tool: 'fetch_page',
      actionName: 'Fetch page content',
      description: 'Fetch URL',
      params: { url: 'https://example.com' }
    };

    const executor = async () => ({ html: 'ok' });

    const firstRun = await actionEngine.executeAction(ctx, actionReq, executor);
    expect(firstRun.success).toBe(true);

    const secondRun = await actionEngine.executeAction(ctx, actionReq, executor);
    expect(secondRun.success).toBe(false);
    expect(secondRun.error).toBe('ACTION_REPLAY_REJECTED');
  });

  it('allows retry after action execution failure', async () => {
    const permEngine = new PermissionEngine();
    permEngine.grantInMemory('u1', 'web.read');

    const policyEngine = new PolicyEngine();
    const mockAuditRepo = { addAuditLog: async () => ({}) } as any;
    const logger = new AuditLogger(mockAuditRepo);
    const actionEngine = new ActionEngine(permEngine, policyEngine, logger, null, TEST_SECRET);

    const ctx: AgentExecutionContext = {
      agentId: 'agent-browser',
      agentType: 'BrowserAgent',
      userId: 'u1',
      currentDepth: 1,
      currentIteration: 1,
      startTime: Date.now()
    };

    const actionReq = {
      actionId: 'act-retry-test',
      capability: 'web.read' as const,
      tool: 'fetch_page',
      actionName: 'Fetch page content',
      description: 'Fetch URL',
      params: { url: 'https://example.com' }
    };

    let attempts = 0;
    const failingExecutor = async () => {
      attempts++;
      if (attempts === 1) throw new Error('NETWORK_TIMEOUT');
      return { html: 'ok' };
    };

    const firstRun = await actionEngine.executeAction(ctx, actionReq, failingExecutor);
    expect(firstRun.success).toBe(false);

    const secondRun = await actionEngine.executeAction(ctx, actionReq, failingExecutor);
    expect(secondRun.success).toBe(true);
  });

  it('requires HMAC cryptographically signed approval for HIGH risk actions and fails if secret missing', async () => {
    const permEngine = new PermissionEngine();
    permEngine.grantInMemory('u1', 'screen.capture', 'ws-approval', 'agent-companion');

    const policyEngine = new PolicyEngine();
    const actionStates = new Map<string, 'pending' | 'executed' | 'failed' | 'cancelled'>();
    const consumedApprovals = new Set<string>();
    const mockAuditRepo = {
      addAuditLog: async () => ({}),
      reserveAction: async ({ actionId }: { actionId: string }) => {
        const existing = actionStates.get(actionId);
        if (existing === 'pending' || existing === 'executed') {
          return { reserved: false, existingStatus: existing };
        }
        actionStates.set(actionId, 'pending');
        return { reserved: true, existingStatus: existing };
      },
      updateActionStatus: async ({ actionId, status }: { actionId: string; status: 'executed' | 'failed' | 'cancelled' }) => {
        if (!actionStates.has(actionId)) return false;
        actionStates.set(actionId, status);
        return true;
      },
      consumeApproval: async ({ approvalId }: { approvalId: string }) => {
        if (consumedApprovals.has(approvalId)) return false;
        consumedApprovals.add(approvalId);
        return true;
      }
    } as any;
    const logger = new AuditLogger(mockAuditRepo);

    // Engine without secret -> fails closed before any approval can be consumed.
    const noSecretEngine = new ActionEngine(permEngine, policyEngine, logger, mockAuditRepo, undefined);

    const ctx: AgentExecutionContext = {
      agentId: 'agent-companion',
      agentType: 'PersonalAssistantAgent',
      userId: 'u1',
      workspaceId: 'ws-approval',
      currentDepth: 1,
      currentIteration: 1,
      startTime: Date.now()
    };

    const baseApproval: Omit<ActionApproval, 'signature'> = {
      approvalId: 'appr-1',
      userId: 'u1',
      workspaceId: 'ws-approval',
      agentId: 'agent-companion',
      actionId: 'act-approval-test',
      capability: 'screen.capture',
      scope: { region: 'full' },
      timestamp: Date.now(),
      decision: 'approved',
      expiresAt: Date.now() + 60000
    };

    const noSecretRes = await noSecretEngine.executeAction(
      ctx,
      {
        actionId: 'act-approval-test',
        capability: 'screen.capture',
        tool: 'capture_screen',
        actionName: 'Capture Screen',
        description: 'Capture screen frame',
        params: { region: 'full' },
        approval: { ...baseApproval, signature: 'any' }
      },
      async () => ({ frame: 'img' })
    );

    expect(noSecretRes.success).toBe(false);
    expect(noSecretRes.error).toBe('ACTION_APPROVAL_SECRET_REQUIRED');

    // Engine with secret
    const actionEngine = new ActionEngine(permEngine, policyEngine, logger, mockAuditRepo, TEST_SECRET);

    // Tampered scope
    const validSig = signApproval(baseApproval, TEST_SECRET);
    const tamperedScopeApproval: ActionApproval = {
      ...baseApproval,
      scope: { region: 'full', hacked: true },
      signature: validSig
    };

    const tamperedRes = await actionEngine.executeAction(
      ctx,
      {
        actionId: 'act-approval-test',
        capability: 'screen.capture',
        tool: 'capture_screen',
        actionName: 'Capture Screen',
        description: 'Capture screen frame',
        params: { region: 'full' },
        approval: tamperedScopeApproval
      },
      async () => ({ frame: 'img' })
    );

    expect(tamperedRes.success).toBe(false);
    expect(tamperedRes.status).toBe('waiting_approval');

    // A correctly signed approval from another agent scope must not be accepted.
    const wrongAgentApprovalBase: Omit<ActionApproval, 'signature'> = {
      ...baseApproval,
      approvalId: 'appr-wrong-agent',
      agentId: 'agent-other'
    };
    const wrongAgentApproval: ActionApproval = {
      ...wrongAgentApprovalBase,
      signature: signApproval(wrongAgentApprovalBase, TEST_SECRET)
    };
    const wrongAgentRes = await actionEngine.executeAction(
      ctx,
      {
        actionId: 'act-approval-test',
        capability: 'screen.capture',
        tool: 'capture_screen',
        actionName: 'Capture Screen',
        description: 'Capture screen frame',
        params: { region: 'full' },
        approval: wrongAgentApproval
      },
      async () => ({ frame: 'img' })
    );
    expect(wrongAgentRes.success).toBe(false);
    expect(wrongAgentRes.status).toBe('waiting_approval');

    // Valid approval
    const validApproval: ActionApproval = {
      ...baseApproval,
      signature: validSig
    };

    const approvedRes = await actionEngine.executeAction(
      ctx,
      {
        actionId: 'act-approval-test',
        capability: 'screen.capture',
        tool: 'capture_screen',
        actionName: 'Capture Screen',
        description: 'Capture screen frame',
        params: { region: 'full' },
        approval: validApproval
      },
      async () => ({ frame: 'img' })
    );

    expect(approvedRes.success).toBe(true);
    expect(approvedRes.status).toBe('executed');
  });
});

describe('Approval durability ordering', () => {
  it('does not consume an approval when mandatory pre-execution audit fails', async () => {
    const permEngine = new PermissionEngine();
    permEngine.grantInMemory('u1', 'screen.capture', 'ws-approval', 'agent-companion');
    const policyEngine = new PolicyEngine();
    let consumed = false;
    let status: string = 'pending';

    const repo = {
      addAuditLog: async () => {
        throw new Error('AUDIT_DB_DOWN');
      },
      reserveAction: async () => {
        status = 'pending';
        return { reserved: true };
      },
      updateActionStatus: async ({ status: next }: { status: string }) => {
        status = next;
        return true;
      },
      consumeApproval: async () => {
        consumed = true;
        return true;
      }
    } as any;

    const logger = new AuditLogger(repo);
    const engine = new ActionEngine(permEngine, policyEngine, logger, repo, TEST_SECRET);
    const ctx: AgentExecutionContext = {
      agentId: 'agent-companion',
      agentType: 'PersonalAssistantAgent',
      userId: 'u1',
      workspaceId: 'ws-approval',
      currentDepth: 1,
      currentIteration: 1,
      startTime: Date.now()
    };

    const approvalBase: Omit<ActionApproval, 'signature'> = {
      approvalId: 'appr-audit-failure',
      userId: 'u1',
      workspaceId: 'ws-approval',
      agentId: 'agent-companion',
      actionId: 'act-audit-failure',
      capability: 'screen.capture',
      scope: { region: 'full' },
      timestamp: Date.now(),
      decision: 'approved',
      expiresAt: Date.now() + 60000
    };

    const result = await engine.executeAction(
      ctx,
      {
        actionId: approvalBase.actionId,
        capability: approvalBase.capability,
        tool: 'capture_screen',
        actionName: 'Capture Screen',
        description: 'Capture screen frame',
        params: { region: 'full' },
        approval: { ...approvalBase, signature: signApproval(approvalBase, TEST_SECRET) }
      },
      async () => ({ frame: 'img' })
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('MANDATORY_AUDIT_LOG_FAILED');
    expect(consumed).toBe(false);
    expect(status).toBe('failed');
  });
});

import { BoundedAgentExecutor, createToolRegistry } from './runtime.js';
import type { AgentTask } from '@nexaforge/shared';

describe('BoundedAgentExecutor Real Execution Limits Call-Sites', () => {
  it('enforces execution limits during real BoundedAgentExecutor.run() execution', async () => {
    const mockModel = {
      invoke: async () => 'mock response'
    } as any;

    const mockAgentRuntime = {
      plan: async () => [{ tool: 'time', params: {} }],
      execute: async () => [{ tool: 'time', params: {}, result: '12:00', status: 'completed' as const }],
      synthesize: async () => 'Answer synthesized'
    } as any;

    const registry = createToolRegistry([]);
    const executor = new BoundedAgentExecutor(mockAgentRuntime, registry);

    const task: AgentTask = {
      id: 'task-limits-test',
      workspaceId: 'ws-test',
      prompt: 'What time is it?',
      mode: 'auto',
      status: 'running',
      maxIterations: 12
    };

    // 1. Normal run succeeds
    const res = await executor.run(task);
    expect(res.status).toBe('completed');
    expect(res.metrics?.toolCalls).toBe(1);
    expect(res.metrics?.modelCalls).toBe(2);

    // 2. Cancelled via AbortSignal -> throws AGENT_EXECUTION_CANCELLED
    const controller = new AbortController();
    controller.abort();
    await expect(executor.run(task, { signal: controller.signal })).rejects.toThrow('AGENT_EXECUTION_CANCELLED');
  });
});
