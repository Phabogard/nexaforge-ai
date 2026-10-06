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

    // FAIL CLOSED: Persistent DB audit is MANDATORY for HIGH and CRITICAL actions
    if (riskLevel === 'HIGH' || riskLevel === 'CRITICAL') {
      if (!this.repository) {
        throw new Error(`PERSISTENT_AUDIT_LOG_REQUIRED: Persistent audit repository is required before executing ${riskLevel} risk action ${input.capability}`);
      }

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
        throw new Error(`PERSISTENT_AUDIT_LOG_FAILED: Failed to write required persistent audit log for ${riskLevel} risk action ${input.capability}. ${String(err)}`);
      }
    } else {
      // LOW/MEDIUM risk actions may log to DB if available, falling back to memory
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
          console.warn(`[AUDIT_LOG_WARN] Failed to write non-critical audit log to DB for ${input.capability}:`, err);
        }
      }
    }

    this.inMemoryLogs.push(entry);
  }

  getLogs(): AuditLogInput[] {
    return [...this.inMemoryLogs];
  }
}
