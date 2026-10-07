import type { PermissionCheckRequest, PermissionCheckResult } from '@nexaforge/shared';
import type { PermissionRepository } from '@nexaforge/db';

export class PermissionEngine {
  private inMemoryPermissions: Map<string, { userId: string; capability: string; workspaceId?: string; agentId?: string; status: string; expiresAt?: number }> = new Map();

  constructor(private repository?: PermissionRepository | null) {}

  grantInMemory(
    userId: string,
    capability: string,
    workspaceId?: string,
    agentId?: string,
    durationMs?: number
  ) {
    const key = `${userId}:${workspaceId ?? 'global'}:${agentId ?? 'any'}:${capability}`;
    const expiresAt = durationMs !== undefined ? Date.now() + durationMs : undefined;
    this.inMemoryPermissions.set(key, { userId, capability, workspaceId, agentId, status: 'granted', expiresAt });
  }

  revokeInMemory(userId: string, capability: string, workspaceId?: string, agentId?: string) {
    const key = `${userId}:${workspaceId ?? 'global'}:${agentId ?? 'any'}:${capability}`;
    const existing = this.inMemoryPermissions.get(key);
    if (existing) {
      existing.status = 'revoked';
      this.inMemoryPermissions.set(key, existing);
    } else {
      this.inMemoryPermissions.set(key, { userId, capability, workspaceId, agentId, status: 'revoked' });
    }
  }

  async checkPermission(req: PermissionCheckRequest): Promise<PermissionCheckResult> {
    const reqWorkspace = req.workspaceId ?? 'global';
    const reqAgent = req.agentId ?? 'any';

    // 1. Check in-memory permissions with strict user, workspace, agent, status, and expiration scoping
    const key = `${req.userId}:${reqWorkspace}:${reqAgent}:${req.capability}`;
    let mem = this.inMemoryPermissions.get(key);

    const prefix = req.capability.split('.')[0];
    if (!mem) {
      const wildcardKey = `${req.userId}:${reqWorkspace}:${reqAgent}:${prefix}.*`;
      mem = this.inMemoryPermissions.get(wildcardKey);
    }
    if (!mem) {
      const agentAnyKey = `${req.userId}:${reqWorkspace}:any:${req.capability}`;
      mem = this.inMemoryPermissions.get(agentAnyKey);
    }
    if (!mem) {
      const agentAnyWildcardKey = `${req.userId}:${reqWorkspace}:any:${prefix}.*`;
      mem = this.inMemoryPermissions.get(agentAnyWildcardKey);
    }

    if (mem) {
      if (mem.status !== 'granted') {
        return { granted: false, reason: `Permission ${req.capability} has status ${mem.status}` };
      }
      if (mem.expiresAt && Date.now() > mem.expiresAt) {
        return { granted: false, reason: `Permission ${req.capability} has expired` };
      }
      if (mem.userId !== req.userId) {
        return { granted: false, reason: 'User scope mismatch' };
      }
      if (mem.workspaceId && req.workspaceId && mem.workspaceId !== req.workspaceId) {
        return { granted: false, reason: 'Workspace scope mismatch' };
      }
      if (mem.agentId && req.agentId && mem.agentId !== req.agentId) {
        return { granted: false, reason: 'Agent scope mismatch' };
      }
      return { granted: true, reason: 'In-memory permission granted' };
    }

    // 2. Check DB repository with strict status & workspace/user/agent scoping
    if (this.repository) {
      const dbPerm = await this.repository.getPermission(req.userId, req.capability, req.workspaceId, req.agentId);
      if (dbPerm) {
        if (dbPerm.status !== 'granted') {
          return { granted: false, reason: `DB permission status is ${dbPerm.status}` };
        }
        if (dbPerm.expiresAt && new Date(dbPerm.expiresAt).getTime() <= Date.now()) {
          return { granted: false, reason: 'DB permission has expired' };
        }
        if (dbPerm.userId !== req.userId) {
          return { granted: false, reason: 'User scope mismatch' };
        }
        if (dbPerm.workspaceId && req.workspaceId && dbPerm.workspaceId !== req.workspaceId) {
          return { granted: false, reason: 'Workspace scope mismatch' };
        }
        if (dbPerm.agentId && req.agentId && dbPerm.agentId !== req.agentId) {
          return { granted: false, reason: 'Agent scope mismatch' };
        }
        return { granted: true, permissionId: dbPerm.id, reason: 'DB permission granted' };
      }

      const dbWildcard = await this.repository.getPermission(req.userId, `${prefix}.*`, req.workspaceId, req.agentId);
      if (dbWildcard) {
        if (dbWildcard.status !== 'granted') {
          return { granted: false, reason: `DB wildcard status is ${dbWildcard.status}` };
        }
        if (dbWildcard.expiresAt && new Date(dbWildcard.expiresAt).getTime() <= Date.now()) {
          return { granted: false, reason: 'DB wildcard permission has expired' };
        }
        if (dbWildcard.userId !== req.userId) {
          return { granted: false, reason: 'User scope mismatch' };
        }
        if (dbWildcard.workspaceId && req.workspaceId && dbWildcard.workspaceId !== req.workspaceId) {
          return { granted: false, reason: 'Workspace scope mismatch' };
        }
        if (dbWildcard.agentId && req.agentId && dbWildcard.agentId !== req.agentId) {
          return { granted: false, reason: 'Agent scope mismatch' };
        }
        return { granted: true, permissionId: dbWildcard.id, reason: 'DB wildcard permission granted' };
      }
    }

    return { granted: false, reason: `Permission ${req.capability} not granted for user ${req.userId}` };
  }
}
