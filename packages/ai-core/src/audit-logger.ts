import type { AuditLogInput } from '@nexaforge/shared';
import type { PermissionRepository } from '@nexaforge/db';
import { AuditPayloadSanitizer } from './audit-payload-sanitizer.js';
import { CapabilityEngine } from './capability-engine.js';

export class AuditLogger {
  private inMemoryLogs: AuditLogInput[] = [];

  constructor(private repository?: PermissionRepository | null) {}

  async log(input: AuditLogInput): Promise<void> {
    const sanitizedPayload = AuditPayloadSanitizer.sanitize(input.payload ?? {}) as Record<string, unknown>;

    const entry: AuditLogInput = {
      ...input,
      payload: sanitizedPayload
    };

    const riskLevel = CapabilityEngine.getRiskLevel(input.capability);

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
          payload: sanitizedPayload
        });
      } catch (err) {
        // Fail-closed for HIGH / CRITICAL actions if DB audit logging fails
        if (riskLevel === 'HIGH' || riskLevel === 'CRITICAL') {
          throw new Error(`PERSISTENT_AUDIT_LOG_FAILED: Required persistent audit trail failed for ${riskLevel} risk action ${input.capability}. ${String(err)}`);
        }
        console.warn(`[AUDIT_LOG_WARN] Failed to write non-critical audit log to DB for ${input.capability}:`, err);
      }
    }

    this.inMemoryLogs.push(entry);
  }

  getLogs(): AuditLogInput[] {
    return [...this.inMemoryLogs];
  }
}
