import { describe, expect, it } from 'vitest';
import { AgentSessionManager } from './agent-session.js';
import { PermissionEngine } from './permission-engine.js';

describe('AgentSessionManager', () => {
  it('persists only capabilities currently granted to the scoped agent', async () => {
    const sessions = new Map<string, any>();
    const repository = {
      getPermission: async (userId: string, capability: string, workspaceId?: string, agentId?: string) => {
        if (userId === 'u1' && workspaceId === 'ws1' && agentId === 'agent-1' && capability === 'web.read') {
          return { id: 'perm-1', userId, workspaceId, agentId, capability, status: 'granted', scope: {}, createdAt: '', updatedAt: '' };
        }
        return null;
      },
      createAgentSession: async (input: any) => {
        const record = {
          id: 'session-1',
          userId: input.userId,
          workspaceId: input.workspaceId ?? null,
          agentType: input.agentType,
          status: 'active',
          grantedCapabilities: input.grantedCapabilities ?? [],
          metadata: input.metadata ?? {},
          createdAt: new Date().toISOString(),
          expiresAt: input.expiresAt ?? null
        };
        sessions.set(record.id, record);
        return record;
      },
      getAgentSession: async (id: string) => sessions.get(id) ?? null,
      revokeAgentSession: async (id: string) => {
        const record = sessions.get(id);
        if (!record || record.status !== 'active') return false;
        record.status = 'revoked';
        return true;
      }
    } as any;

    const manager = new AgentSessionManager(repository, new PermissionEngine(repository));
    const session = await manager.start({
      userId: 'u1',
      workspaceId: 'ws1',
      agentId: 'agent-1',
      agentType: 'PersonalAssistantAgent',
      requiredCapabilities: ['web.read', 'screen.capture', 'web.read']
    });

    expect(session.grantedCapabilities).toEqual(['web.read']);
    expect(AgentSessionManager.isCapabilityGranted(session, 'web.read')).toBe(true);
    expect(AgentSessionManager.isCapabilityGranted(session, 'screen.capture')).toBe(false);
    expect(session.metadata.agentId).toBe('agent-1');
  });

  it('enforces session scope on reads and supports revocation', async () => {
    const record = {
      id: 'session-2',
      userId: 'u1',
      workspaceId: 'ws1',
      agentType: 'BrowserAgent',
      status: 'active',
      grantedCapabilities: ['web.read'],
      metadata: { agentId: 'agent-2' },
      createdAt: new Date().toISOString(),
      expiresAt: null
    };
    const repository = {
      getAgentSession: async (id: string) => id === record.id ? record : null,
      revokeAgentSession: async (id: string) => id === record.id
    } as any;

    const manager = new AgentSessionManager(repository, new PermissionEngine(repository));

    expect(await manager.get('session-2', { userId: 'other-user' })).toBeNull();
    expect(await manager.get('session-2', { userId: 'u1', workspaceId: 'ws1', agentId: 'agent-2' })).not.toBeNull();
    expect(await manager.close('session-2', { userId: 'u1', workspaceId: 'ws1', agentId: 'agent-2' })).toBe(true);
  });
});
