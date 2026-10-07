import { describe, expect, it } from 'vitest';
import { ActionEngine, AuditLogger, PermissionEngine, PolicyEngine, createSupervisor, type ModelProvider, type Tool } from './index.js';
import { BoundedAgentExecutor, createToolRegistry } from './runtime.js';

const task = {
  id: 'task-secure-1',
  workspaceId: 'workspace-1',
  prompt: 'Run a governed tool',
  mode: 'auto' as const,
  status: 'running' as const,
  maxIterations: 1
};

function provider(): ModelProvider {
  return {
    async generate() {
      return JSON.stringify([{ objective: 'Execute governed tool', mode: 'auto', tool: 'governed.echo', input: { value: 'ok' } }]);
    }
  };
}

function actionEngine(permission: PermissionEngine): ActionEngine {
  return new ActionEngine(
    permission,
    new PolicyEngine(),
    new AuditLogger()
  );
}

describe('ActionEngine tool gate', () => {
  it('executes a permitted tool through ActionEngine with authenticated context', async () => {
    const permission = new PermissionEngine();
    permission.grantInMemory('user-1', 'ai.execute', 'workspace-1', 'agent-1');

    const tool: Tool = {
      name: 'governed.echo',
      description: 'Echo governed input',
      risk: 'low',
      capability: 'ai.execute',
      async execute(input) {
        return input;
      }
    };

    const runtime = createSupervisor([tool], provider(), actionEngine(permission));
    const executor = new BoundedAgentExecutor(runtime, createToolRegistry([tool]));

    const result = await executor.run(task, {
      context: {
        agentId: 'agent-1',
        agentType: 'PlanningAgent',
        userId: 'user-1',
        workspaceId: 'workspace-1',
        sessionId: 'session-1',
        currentDepth: 1,
        currentIteration: 0,
        startTime: Date.now()
      }
    });

    expect(result.status).toBe('completed');
    expect(result.calls[0]?.status).toBe('completed');
    expect(result.calls[0]?.output).toEqual({ value: 'ok' });
  });

  it('blocks a tool when the authenticated agent lacks its capability', async () => {
    const permission = new PermissionEngine();
    const tool: Tool = {
      name: 'governed.echo',
      description: 'Echo governed input',
      risk: 'low',
      capability: 'ai.execute',
      async execute() {
        throw new Error('MUST_NOT_EXECUTE');
      }
    };

    const runtime = createSupervisor([tool], provider(), actionEngine(permission));
    const result = await new BoundedAgentExecutor(runtime, createToolRegistry([tool])).run(task, {
      context: {
        agentId: 'agent-1',
        agentType: 'PlanningAgent',
        userId: 'user-1',
        workspaceId: 'workspace-1',
        sessionId: 'session-1',
        currentDepth: 1,
        currentIteration: 0,
        startTime: Date.now()
      }
    });

    expect(result.status).toBe('failed');
    expect(result.calls[0]?.status).toBe('blocked');
    expect(result.calls[0]?.output).toEqual({ error: expect.stringContaining('Permission ai.execute') });
  });
});
