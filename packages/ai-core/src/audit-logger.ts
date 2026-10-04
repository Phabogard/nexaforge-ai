import type { AuditLogInput } from '@nexaforge/shared';
import type { PermissionRepository } from '@nexaforge/db';

export class AuditLogger {
  private inMemoryLogs: AuditLogInput[] = [];

  constructor(private repository?: PermissionRepository | null) {}

  async log(input: AuditLogInput): Promise<void> {
    const entry: AuditLogInput = {
      ...input,
      payload: input.payload ?? {}
    };

    this.inMemoryLogs.push(entry);

    if (this.repository) {
      try {
        await this.repository.addAuditLog({
          requestId: input.requestId,
          actor: input.actor,
          actorType: input.actorType,
          userId: input.userId,
          workspaceId: input.workspaceId,
          agentId: input.agentId,
          applicationId: input.applicationId,
          capability: input.capability,
          tool: input.tool,
          action: input.action,
          status: input.status,
          reason: input.reason,
          payload: input.payload
        });
      } catch (err) {
        console.error('Failed to write audit log to DB:', err);
      }
    }
  }

  getLogs(): AuditLogInput[] {
    return [...this.inMemoryLogs];
  }
}
