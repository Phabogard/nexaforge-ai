import type { PermissionCheckRequest, PermissionCheckResult } from '@nexaforge/shared';
import type { PermissionRepository } from '@nexaforge/db';

export class PermissionEngine {
  private inMemoryPermissions: Map<string, { userId: string; capability: string; workspaceId?: string; status: string; expiresAt?: number }> = new Map();

  constructor(private repository?: PermissionRepository | null) {}

  grantInMemory(userId: string, capability: string, workspaceId?: string, durationMs?: number) {
    const key = `${userId}:${workspaceId ?? 'global'}:${capability}`;
    const expiresAt = durationMs ? Date.now() + durationMs : undefined;
    this.inMemoryPermissions.set(key, { userId, capability, workspaceId, status: 'granted', expiresAt });
  }

  revokeInMemory(userId: string, capability: string, workspaceId?: string) {
    const key = `${userId}:${workspaceId ?? 'global'}:${capability}`;
    const existing = this.inMemoryPermissions.get(key);
    if (existing) {
      existing.status = 'revoked';
      this.inMemoryPermissions.set(key, existing);
    } else {
      this.inMemoryPermissions.set(key, { userId, capability, workspaceId, status: 'revoked' });
    }
  }

  async checkPermission(req: PermissionCheckRequest): Promise<PermissionCheckResult> {
    const reqWorkspace = req.workspaceId ?? 'global';

    // 1. Check in-memory permissions with strict status, scope, and expiration
    const key = `${req.userId}:${reqWorkspace}:${req.capability}`;
    const mem = this.inMemoryPermissions.get(key);
    if (mem) {
      if (mem.status !== 'granted') {
        return { granted: false, reason: `Permission ${req.capability} has status ${mem.status}` };
      }
      if (mem.expiresAt && Date.now() > mem.expiresAt) {
        return { granted: false, reason: `Permission ${req.capability} has expired` };
      }
      return { granted: true, reason: 'In-memory permission granted' };
    }

    // Check wildcard in-memory
    const prefix = req.capability.split('.')[0];
    const wildcardKey = `${req.userId}:${reqWorkspace}:${prefix}.*`;
    const memWildcard = this.inMemoryPermissions.get(wildcardKey);
    if (memWildcard) {
      if (memWildcard.status !== 'granted') {
        return { granted: false, reason: `Wildcard permission ${prefix}.* has status ${memWildcard.status}` };
      }
      if (memWildcard.expiresAt && Date.now() > memWildcard.expiresAt) {
        return { granted: false, reason: `Wildcard permission ${prefix}.* has expired` };
      }
      return { granted: true, reason: 'In-memory wildcard permission granted' };
    }

    // 2. Check DB repository with strict status & workspace scoping
    if (this.repository) {
      const dbPerm = await this.repository.getPermission(req.userId, req.capability, req.workspaceId);
      if (dbPerm) {
        if (dbPerm.status !== 'granted') {
          return { granted: false, reason: `DB permission status is ${dbPerm.status}` };
        }
        if (dbPerm.expiresAt && new Date(dbPerm.expiresAt).getTime() <= Date.now()) {
          return { granted: false, reason: 'DB permission has expired' };
        }
        if (dbPerm.workspaceId && req.workspaceId && dbPerm.workspaceId !== req.workspaceId) {
          return { granted: false, reason: 'Workspace scope mismatch' };
        }
        return { granted: true, permissionId: dbPerm.id, reason: 'DB permission granted' };
      }

      const dbWildcard = await this.repository.getPermission(req.userId, `${prefix}.*`, req.workspaceId);
      if (dbWildcard) {
        if (dbWildcard.status !== 'granted') {
          return { granted: false, reason: `DB wildcard status is ${dbWildcard.status}` };
        }
        if (dbWildcard.expiresAt && new Date(dbWildcard.expiresAt).getTime() <= Date.now()) {
          return { granted: false, reason: 'DB wildcard permission has expired' };
        }
        if (dbWildcard.workspaceId && req.workspaceId && dbWildcard.workspaceId !== req.workspaceId) {
          return { granted: false, reason: 'Workspace scope mismatch' };
        }
        return { granted: true, permissionId: dbWildcard.id, reason: 'DB wildcard permission granted' };
      }
    }

    return { granted: false, reason: `Permission ${req.capability} not granted for user ${req.userId}` };
  }
}
