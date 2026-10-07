import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ActionEngine,
  AgentSessionManager,
  AuditLogger,
  BoundedAgentExecutor,
  PermissionEngine,
  PolicyEngine,
  SecureAgentExecutor,
  createSupervisor,
  createToolRegistry,
  type ModelProvider,
  type Tool
} from '@nexaforge/ai-core';
import { verifyBearerToken } from './auth.js';

const JWT_SECRET = 'e2e-only-test-secret-never-used-in-production';
const USER_ID = 'e2e-user';
const WORKSPACE_ID = '00000000-0000-4000-8000-000000000001';
const AGENT_ID = 'e2e-agent';

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signingInput = `${header}.${body}`;
  const signature = createHmac('sha256', JWT_SECRET).update(signingInput).digest('base64url');
  return `${signingInput}.${signature}`;
}

function createRepository() {
  const sessions = new Map<string, any>();
  const actions = new Map<string, any>();
  const audits: any[] = [];
  let sessionCounter = 0;

  return {
    sessions,
    actions,
    audits,

    async createAgentSession(input: any) {
      const id = `session-${++sessionCounter}`;
      const record = {
        id,
        userId: input.userId,
        workspaceId: input.workspaceId ?? null,
        agentType: input.agentType,
        status: 'active',
        grantedCapabilities: input.grantedCapabilities,
        metadata: input.metadata ?? {},
        createdAt: new Date().toISOString(),
        expiresAt: input.expiresAt ?? null
      };
      sessions.set(id, record);
      return record;
    },

    async getAgentSession(id: string) {
      return sessions.get(id) ?? null;
    },

    async getPermission() {
      return null;
    },

    async getPolicy() {
      return null;
    },

    async addAuditLog(input: any) {
      audits.push(input);
      return input;
    },

    async reserveAction(input: any) {
      const existing = actions.get(input.actionId);
      if (existing) {
        return { reserved: false, existingStatus: existing.status };
      }
      actions.set(input.actionId, {
        actionId: input.actionId,
        userId: input.userId,
        workspaceId: input.workspaceId ?? null,
        agentId: input.agentId ?? null,
        status: 'pending'
      });
      return { reserved: true };
    },

    async updateActionStatus(input: any) {
      const action = actions.get(input.actionId);
      if (!action) return null;
      if (
        action.userId !== input.userId ||
        (action.workspaceId ?? null) !== (input.workspaceId ?? null) ||
        (action.agentId ?? null) !== (input.agentId ?? null)
      ) {
        throw new Error('ACTION_SCOPE_MISMATCH');
      }
      action.status = input.status;
      return action;
    }
  };
}

function provider(): ModelProvider {
  return {
    async generate() {
      return JSON.stringify([
        {
          objective: 'Execute the governed echo tool',
          mode: 'auto',
          tool: 'governed.echo',
          input: { value: 'nexaforge-e2e-ok' }
        }
      ]);
    }
  };
}

describe('authenticated agent execution E2E flow', () => {
  beforeEach(() => {
    process.env.NEXAFORGE_AUTH_JWT_SECRET = JWT_SECRET;
  });

  it('carries authenticated identity through session, permission, ActionEngine, audit, tool, and result', async () => {
    const authorization = `Bearer ${makeJwt({
      sub: USER_ID,
      workspace_id: WORKSPACE_ID,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300
    })}`;

    const identity = verifyBearerToken(authorization);
    expect(identity).toEqual({ userId: USER_ID, workspaceId: WORKSPACE_ID });

    const repository = createRepository();
    const permission = new PermissionEngine(repository as any);
    permission.grantInMemory(USER_ID, 'ai.execute', WORKSPACE_ID, AGENT_ID);

    const sessions = new AgentSessionManager(repository as any, permission);
    const session = await sessions.start({
      userId: identity.userId,
      workspaceId: identity.workspaceId,
      agentId: AGENT_ID,
      agentType: 'PlanningAgent',
      requiredCapabilities: ['ai.execute']
    });

    expect(session.grantedCapabilities).toEqual(['ai.execute']);

    const policy = new PolicyEngine(repository as any);
    const audit = new AuditLogger(repository as any);
    const actionEngine = new ActionEngine(permission, policy, audit, repository as any);

    let executedBy = '';
    const tool: Tool = {
      name: 'governed.echo',
      description: 'Echo a value through the governed execution path',
      risk: 'low',
      capability: 'ai.execute',
      async execute(input, context) {
        executedBy = context.task.workspaceId ?? '';
        return input;
      }
    };

    const runtime = createSupervisor([tool], provider(), actionEngine);
    const bounded = new BoundedAgentExecutor(runtime, createToolRegistry([tool]));
    const secure = new SecureAgentExecutor(repository as any, bounded);

    const result = await secure.run({
      task: {
        id: 'task-e2e-1',
        workspaceId: WORKSPACE_ID,
        prompt: 'Execute the governed echo tool',
        mode: 'auto',
        status: 'running',
        maxIterations: 1
      },
      userId: identity.userId,
      workspaceId: identity.workspaceId,
      agentId: AGENT_ID,
      agentType: session.agentType,
      sessionId: session.id,
      requiredCapabilities: ['ai.execute']
    });

    expect(result.status).toBe('completed');
    expect(result.calls[0]?.status).toBe('completed');
    expect(result.calls[0]?.output).toEqual({ value: 'nexaforge-e2e-ok' });
    expect(executedBy).toBe(WORKSPACE_ID);

    const executedAction = repository.actions.get('task-e2e-1');
    expect(executedAction?.status).toBe('executed');
    expect(repository.audits.some((entry) =>
      entry.userId === USER_ID &&
      entry.workspaceId === WORKSPACE_ID &&
      entry.agentId === AGENT_ID &&
      entry.capability === 'ai.execute' &&
      entry.status === 'executed'
    )).toBe(true);
  });

  it('rejects a token that is validly signed but outside its validity window', () => {
    const token = makeJwt({
      sub: USER_ID,
      workspace_id: WORKSPACE_ID,
      nbf: Math.floor(Date.now() / 1000) + 60,
      exp: Math.floor(Date.now() / 1000) + 300
    });

    expect(() => verifyBearerToken(`Bearer ${token}`)).toThrow('AUTH_TOKEN_NOT_YET_VALID');
  });
});
