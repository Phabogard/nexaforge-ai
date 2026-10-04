import { describe, expect, it } from 'vitest';
import { AgentRuntime, type AgentExecutionContext } from './agent-runtime.js';
import { ActionEngine } from './action-engine.js';
import { PermissionEngine } from './permission-engine.js';
import { PolicyEngine } from './policy-engine.js';
import { AuditLogger } from './audit-logger.js';

describe('Agent Runtime & Action Engine', () => {
  it('enforces execution limits and abort signal', () => {
    const ctx: AgentExecutionContext = {
      agentId: 'a1',
      agentType: 'PlanningAgent',
      userId: 'u1',
      currentDepth: 1,
      currentIteration: 1,
      startTime: Date.now()
    };

    expect(() => AgentRuntime.validateLimits(ctx)).not.toThrow();

    const exceededIterationCtx = { ...ctx, currentIteration: 15 };
    expect(() => AgentRuntime.validateLimits(exceededIterationCtx)).toThrow('MAX_AGENT_ITERATIONS_EXCEEDED');

    const exceededDepthCtx = { ...ctx, currentDepth: 5 };
    expect(() => AgentRuntime.validateLimits(exceededDepthCtx)).toThrow('MAX_AGENT_RECURSION_DEPTH_EXCEEDED');

    const abortController = new AbortController();
    abortController.abort();
    const cancelledCtx = { ...ctx, signal: abortController.signal };
    expect(() => AgentRuntime.validateLimits(cancelledCtx)).toThrow('AGENT_EXECUTION_CANCELLED');
  });

  it('blocks unpermitted action execution', async () => {
    const permEngine = new PermissionEngine();
    const policyEngine = new PolicyEngine();
    const logger = new AuditLogger();
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
      actionId: 'act-1',
      capability: 'web.read',
      tool: 'fetch_page',
      actionName: 'Fetch page content',
      description: 'Fetch URL',
      params: { url: 'https://example.com' }
    });

    expect(res.success).toBe(false);
    expect(res.status).toBe('denied');
    expect(res.error).toContain('not granted');
  });

  it('executes allowed action when permission is granted', async () => {
    const permEngine = new PermissionEngine();
    permEngine.grantInMemory('u1', 'web.read');

    const policyEngine = new PolicyEngine();
    const logger = new AuditLogger();
    const actionEngine = new ActionEngine(permEngine, policyEngine, logger);

    const ctx: AgentExecutionContext = {
      agentId: 'agent-browser',
      agentType: 'BrowserAgent',
      userId: 'u1',
      currentDepth: 1,
      currentIteration: 1,
      startTime: Date.now()
    };

    const res = await actionEngine.executeAction(
      ctx,
      {
        actionId: 'act-2',
        capability: 'web.read',
        tool: 'fetch_page',
        actionName: 'Fetch page content',
        description: 'Fetch URL',
        params: { url: 'https://example.com' }
      },
      async (params) => ({ html: '<html>ok</html>', url: params.url })
    );

    expect(res.success).toBe(true);
    expect(res.status).toBe('executed');
    expect(res.result).toEqual({ html: '<html>ok</html>', url: 'https://example.com' });

    const logs = logger.getLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0].status).toBe('executed');
  });

  it('requires explicit approval for high risk actions when not yet approved', async () => {
    const permEngine = new PermissionEngine();
    permEngine.grantInMemory('u1', 'screen.capture');

    const policyEngine = new PolicyEngine();
    const logger = new AuditLogger();
    const actionEngine = new ActionEngine(permEngine, policyEngine, logger);

    const ctx: AgentExecutionContext = {
      agentId: 'agent-companion',
      agentType: 'PersonalAssistantAgent',
      userId: 'u1',
      currentDepth: 1,
      currentIteration: 1,
      startTime: Date.now()
    };

    const res = await actionEngine.executeAction(ctx, {
      actionId: 'act-3',
      capability: 'screen.capture',
      tool: 'capture_screen',
      actionName: 'Capture Screen',
      description: 'Capture screen frame for analysis',
      params: { region: 'full' },
      userApproved: false
    });

    expect(res.success).toBe(false);
    expect(res.status).toBe('waiting_approval');
    expect(res.preview?.requiresUserApproval).toBe(true);
    expect(res.preview?.riskLevel).toBe('HIGH');
  });
});
