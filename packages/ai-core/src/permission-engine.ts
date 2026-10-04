import type { PermissionCheckRequest, PermissionCheckResult } from '@nexaforge/shared';
import type { PermissionRepository } from '@nexaforge/db';
import { CapabilityEngine } from './capability-engine.js';

export class PermissionEngine {
  private inMemoryPermissions: Map<string, { userId: string; capability: string; workspaceId?: string; expiresAt?: number }> = new Map();

  constructor(private repository?: PermissionRepository | null) {}

  grantInMemory(userId: string, capability: string, workspaceId?: string, durationMs?: number) {
    const key = `${userId}:${workspaceId ?? 'global'}:${capability}`;
    const expiresAt = durationMs ? Date.now() + durationMs : undefined;
    this.inMemoryPermissions.set(key, { userId, capability, workspaceId, expiresAt });
  }

  revokeInMemory(userId: string, capability: string, workspaceId?: string) {
    const key = `${userId}:${workspaceId ?? 'global'}:${capability}`;
    this.inMemoryPermissions.delete(key);
  }

  async checkPermission(req: PermissionCheckRequest): Promise<PermissionCheckResult> {
    // 1. Check in-memory session permissions
    const key = `${req.userId}:${req.workspaceId ?? 'global'}:${req.capability}`;
    const mem = this.inMemoryPermissions.get(key);
    if (mem) {
      if (mem.expiresAt && Date.now() > mem.expiresAt) {
        this.inMemoryPermissions.delete(key);
      } else {
        return { granted: true, reason: 'In-memory permission granted' };
      }
    }

    // Wildcard check in memory
    const prefix = req.capability.split('.')[0];
    const wildcardKey = `${req.userId}:${req.workspaceId ?? 'global'}:${prefix}.*`;
    const memWildcard = this.inMemoryPermissions.get(wildcardKey);
    if (memWildcard) {
      if (!memWildcard.expiresAt || Date.now() <= memWildcard.expiresAt) {
        return { granted: true, reason: 'In-memory wildcard permission granted' };
      }
    }

    // 2. Check DB repository if available
    if (this.repository) {
      const dbPerm = await this.repository.getPermission(req.userId, req.capability, req.workspaceId);
      if (dbPerm) {
        return { granted: true, permissionId: dbPerm.id, reason: 'DB permission granted' };
      }

      const dbWildcard = await this.repository.getPermission(req.userId, `${prefix}.*`, req.workspaceId);
      if (dbWildcard) {
        return { granted: true, permissionId: dbWildcard.id, reason: 'DB wildcard permission granted' };
      }
    }

    return { granted: false, reason: `Permission ${req.capability} not granted for user ${req.userId}` };
  }
}
