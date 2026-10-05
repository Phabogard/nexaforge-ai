import { describe, expect, it } from 'vitest';
import { AgentRuntime, type AgentExecutionContext } from './agent-runtime.js';
import { ActionEngine, signApproval, type ActionApproval } from './action-engine.js';
import { PermissionEngine } from './permission-engine.js';
import { PolicyEngine } from './policy-engine.js';
import { AuditLogger } from './audit-logger.js';

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
    const actionEngine = new ActionEngine(permEngine, policyEngine, logger);

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
    const actionEngine = new ActionEngine(permEngine, policyEngine, logger);

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
    const actionEngine = new ActionEngine(permEngine, policyEngine, logger);

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

  it('requires HMAC cryptographically signed approval for HIGH risk actions', async () => {
    const permEngine = new PermissionEngine();
    permEngine.grantInMemory('u1', 'screen.capture');

    const policyEngine = new PolicyEngine();
    const mockAuditRepo = { addAuditLog: async () => ({}) } as any;
    const logger = new AuditLogger(mockAuditRepo);
    const actionEngine = new ActionEngine(permEngine, policyEngine, logger);

    const ctx: AgentExecutionContext = {
      agentId: 'agent-companion',
      agentType: 'PersonalAssistantAgent',
      userId: 'u1',
      currentDepth: 1,
      currentIteration: 1,
      startTime: Date.now()
    };

    const baseApproval: Omit<ActionApproval, 'signature'> = {
      approvalId: 'appr-1',
      userId: 'u1',
      actionId: 'act-approval-test',
      capability: 'screen.capture',
      timestamp: Date.now(),
      decision: 'approved',
      expiresAt: Date.now() + 60000
    };

    // 1. Unsigned approval -> rejected
    const unsignedRes = await actionEngine.executeAction(
      ctx,
      {
        actionId: 'act-approval-test',
        capability: 'screen.capture',
        tool: 'capture_screen',
        actionName: 'Capture Screen',
        description: 'Capture screen frame',
        params: { region: 'full' },
        approval: baseApproval as ActionApproval
      },
      async () => ({ frame: 'img' })
    );

    expect(unsignedRes.success).toBe(false);
    expect(unsignedRes.status).toBe('waiting_approval');

    // 2. Tampered approval -> rejected
    const validSignature = signApproval(baseApproval);
    const tamperedApproval: ActionApproval = {
      ...baseApproval,
      userId: 'u2-hacker', // modified user
      signature: validSignature
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
        approval: tamperedApproval
      },
      async () => ({ frame: 'img' })
    );

    expect(tamperedRes.success).toBe(false);
    expect(tamperedRes.status).toBe('waiting_approval');

    // 3. Valid signed approval -> executed
    const validApproval: ActionApproval = {
      ...baseApproval,
      signature: validSignature
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
