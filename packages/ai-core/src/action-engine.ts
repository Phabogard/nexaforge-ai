import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Capability, RiskLevel } from '@nexaforge/shared';
import type { PermissionRepository } from '@nexaforge/db';
import { CapabilityEngine } from './capability-engine.js';
import { PermissionEngine } from './permission-engine.js';
import { PolicyEngine } from './policy-engine.js';
import { AuditLogger } from './audit-logger.js';
import type { AgentExecutionContext } from './agent-runtime.js';

export interface ActionApproval {
  approvalId: string;
  userId: string;
  workspaceId?: string;
  agentId?: string;
  actionId: string;
  capability: Capability;
  timestamp: number;
  decision: 'approved' | 'rejected';
  scope?: Record<string, unknown>;
  expiresAt: number;
  signature?: string;
}

export interface ActionPreview {
  actionId: string;
  capability: Capability;
  tool?: string;
  riskLevel: RiskLevel;
  description: string;
  params: Record<string, unknown>;
  requiresUserApproval: boolean;
}

export interface ActionExecutionRequest {
  actionId: string;
  capability: Capability;
  tool?: string;
  actionName: string;
  description: string;
  params: Record<string, unknown>;
  approval?: ActionApproval;
  timeoutMs?: number;
}

export interface ActionExecutionResult {
  success: boolean;
  status: 'executed' | 'denied' | 'waiting_approval' | 'failed';
  preview?: ActionPreview;
  result?: unknown;
  error?: string;
}

export function canonicalizeScope(scope?: Record<string, unknown>): string {
  if (!scope || Object.keys(scope).length === 0) return '';
  const sortedKeys = Object.keys(scope).sort();
  const pairs = sortedKeys.map(k => `${k}:${JSON.stringify(scope[k])}`);
  return pairs.join(';');
}

export function computeApprovalCanonicalPayload(approval: Omit<ActionApproval, 'signature'>): string {
  const scopeStr = canonicalizeScope(approval.scope);
  return [
    approval.approvalId,
    approval.userId,
    approval.workspaceId ?? '',
    approval.agentId ?? '',
    approval.actionId,
    approval.capability,
    String(approval.timestamp),
    approval.decision,
    scopeStr,
    String(approval.expiresAt)
  ].join('|');
}

export function signApproval(approval: Omit<ActionApproval, 'signature'>, secret = process.env.ACTION_APPROVAL_SECRET): string {
  if (!secret) {
    throw new Error('ACTION_APPROVAL_SECRET_REQUIRED: process.env.ACTION_APPROVAL_SECRET or an explicit secret must be provided for HMAC approval signing.');
  }
  const canonical = computeApprovalCanonicalPayload(approval);
  return createHmac('sha256', secret).update(canonical).digest('hex');
}

export function verifyApprovalSignature(approval: ActionApproval, secret = process.env.ACTION_APPROVAL_SECRET): boolean {
  if (!secret) return false;
  if (!approval.signature) return false;
  try {
    const expectedSignature = signApproval(approval, secret);
    const sigBuffer = Buffer.from(approval.signature, "hex");
    const expectedBuffer = Buffer.from(expectedSignature, "hex");

    if (sigBuffer.length !== expectedBuffer.length) {
      return false;
    }

    return timingSafeEqual(sigBuffer, expectedBuffer);
  } catch {
    return false;
  }
}

export class ActionEngine {
  private inMemoryExecutedActions: Set<string> = new Set();
  private inMemoryConsumedApprovals: Set<string> = new Set();

  constructor(
    private permissionEngine: PermissionEngine,
    private policyEngine: PolicyEngine,
    private auditLogger: AuditLogger,
    private repository?: PermissionRepository | null,
    private approvalSecret = process.env.ACTION_APPROVAL_SECRET
  ) {}

  async executeAction(
    ctx: AgentExecutionContext,
    req: ActionExecutionRequest,
    toolExecutor?: (params: Record<string, unknown>, options?: { signal?: AbortSignal }) => Promise<unknown>
  ): Promise<ActionExecutionResult> {
    // 0. Check cancellation early
    if (ctx.signal?.aborted) {
      await this.auditLogger.log({
        actor: ctx.agentId,
        actorType: 'agent',
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
        agentId: ctx.agentId,
        capability: req.capability,
        tool: req.tool,
        action: req.actionName,
        status: 'failed',
        reason: 'ACTION_CANCELLED',
        payload: req.params
      });

      return {
        success: false,
        status: 'failed',
        error: 'ACTION_CANCELLED'
      };
    }

    // 0.1 Fail-closed if no real toolExecutor provided
    if (!toolExecutor) {
      await this.auditLogger.log({
        actor: ctx.agentId,
        actorType: 'agent',
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
        agentId: ctx.agentId,
        capability: req.capability,
        tool: req.tool,
        action: req.actionName,
        status: 'failed',
        reason: 'TOOL_EXECUTOR_REQUIRED: Action engine requires a non-null toolExecutor function',
        payload: req.params
      });

      return {
        success: false,
        status: 'failed',
        error: 'TOOL_EXECUTOR_REQUIRED'
      };
    }

    // 0.2 ATOMIC ACTION RESERVATION (PostgreSQL DB or In-Memory)
    if (this.repository) {
      const reservation = await this.repository.reserveAction({
        actionId: req.actionId,
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
        agentId: ctx.agentId
      });

      if (!reservation.reserved) {
        await this.auditLogger.log({
          actor: ctx.agentId,
          actorType: 'agent',
          userId: ctx.userId,
          workspaceId: ctx.workspaceId,
          agentId: ctx.agentId,
          capability: req.capability,
          tool: req.tool,
          action: req.actionName,
          status: 'denied',
          reason: `ACTION_REPLAY_REJECTED: Action ${req.actionId} has already been reserved or executed in status ${reservation.existingStatus}`,
          payload: req.params
        });

        return {
          success: false,
          status: 'denied',
          error: 'ACTION_REPLAY_REJECTED'
        };
      }
    } else {
      if (this.inMemoryExecutedActions.has(req.actionId)) {
        await this.auditLogger.log({
          actor: ctx.agentId,
          actorType: 'agent',
          userId: ctx.userId,
          workspaceId: ctx.workspaceId,
          agentId: ctx.agentId,
          capability: req.capability,
          tool: req.tool,
          action: req.actionName,
          status: 'denied',
          reason: `ACTION_REPLAY_REJECTED: Action ${req.actionId} has already been executed`,
          payload: req.params
        });

        return {
          success: false,
          status: 'denied',
          error: 'ACTION_REPLAY_REJECTED'
        };
      }
      this.inMemoryExecutedActions.add(req.actionId);
    }

    const riskLevel = CapabilityEngine.getRiskLevel(req.capability);

    // Helper to cleanup reservation on failure
    const rollbackReservation = async (status: 'failed' | 'cancelled') => {
      if (this.repository) {
        await this.repository.updateActionStatus({ actionId: req.actionId, userId: ctx.userId, workspaceId: ctx.workspaceId, agentId: ctx.agentId, status });
      } else {
        this.inMemoryExecutedActions.delete(req.actionId);
      }
    };

    // 1. Check capability permission
    const permResult = await this.permissionEngine.checkPermission({
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
      agentId: ctx.agentId,
      capability: req.capability
    });

    if (!permResult.granted) {
      await rollbackReservation('failed');
      await this.auditLogger.log({
        actor: ctx.agentId,
        actorType: 'agent',
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
        agentId: ctx.agentId,
        capability: req.capability,
        tool: req.tool,
        action: req.actionName,
        status: 'denied',
        reason: permResult.reason ?? 'Permission denied',
        payload: req.params
      });

      return {
        success: false,
        status: 'denied',
        error: permResult.reason ?? 'PERMISSION_DENIED'
      };
    }

    // 2. Evaluate security policy
    const policyResult = await this.policyEngine.evaluatePolicy({
      workspaceId: ctx.workspaceId,
      capability: req.capability,
      tool: req.tool,
      riskLevel
    });

    if (policyResult.decision === 'deny') {
      await rollbackReservation('failed');
      await this.auditLogger.log({
        actor: ctx.agentId,
        actorType: 'agent',
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
        agentId: ctx.agentId,
        capability: req.capability,
        tool: req.tool,
        action: req.actionName,
        status: 'denied',
        reason: policyResult.reason ?? 'Policy denied execution',
        payload: req.params
      });

      return {
        success: false,
        status: 'denied',
        error: policyResult.reason ?? 'POLICY_DENIED'
      };
    }

    // 3. Handle required approval with HMAC signature verification and single-use consumption
    if (policyResult.decision === 'require_approval') {
      const approval = req.approval;

      // Fail-closed if ACTION_APPROVAL_SECRET is missing or not configured
      const secretToUse = this.approvalSecret || process.env.ACTION_APPROVAL_SECRET;
      if (!secretToUse) {
        await rollbackReservation('failed');
        await this.auditLogger.log({
          actor: ctx.agentId,
          actorType: 'agent',
          userId: ctx.userId,
          workspaceId: ctx.workspaceId,
          agentId: ctx.agentId,
          capability: req.capability,
          tool: req.tool,
          action: req.actionName,
          status: 'failed',
          reason: 'ACTION_APPROVAL_SECRET_REQUIRED: Cannot verify approval signature without configured secret',
          payload: req.params
        });

        return {
          success: false,
          status: 'failed',
          error: 'ACTION_APPROVAL_SECRET_REQUIRED'
        };
      }

      const isValidSignature = approval ? verifyApprovalSignature(approval, secretToUse) : false;

      const isValidApproval =
        approval &&
        isValidSignature &&
        approval.decision === 'approved' &&
        approval.actionId === req.actionId &&
        approval.userId === ctx.userId &&
        (approval.workspaceId ?? null) === (ctx.workspaceId ?? null) &&
        (approval.agentId ?? null) === (ctx.agentId ?? null) &&
        approval.capability === req.capability &&
        Date.now() <= approval.expiresAt &&
        !this.inMemoryConsumedApprovals.has(approval.approvalId);

      if (!isValidApproval) {
        await rollbackReservation('failed');

        const preview: ActionPreview = {
          actionId: req.actionId,
          capability: req.capability,
          tool: req.tool,
          riskLevel,
          description: req.description,
          params: req.params,
          requiresUserApproval: true
        };

        await this.auditLogger.log({
          actor: ctx.agentId,
          actorType: 'agent',
          userId: ctx.userId,
          workspaceId: ctx.workspaceId,
          agentId: ctx.agentId,
          capability: req.capability,
          tool: req.tool,
          action: req.actionName,
          status: 'denied',
          reason: 'Action requires valid signed unused user approval',
          payload: { preview }
        });

        return {
          success: false,
          status: 'waiting_approval',
          preview,
          error: 'EXPLICIT_APPROVAL_REQUIRED'
        };
      }

    // 4. MANDATORY PRE-EXECUTION AUDIT FOR HIGH / CRITICAL ACTIONS
    if (riskLevel === 'HIGH' || riskLevel === 'CRITICAL') {
      try {
        await this.auditLogger.log({
          actor: ctx.agentId,
          actorType: 'agent',
          userId: ctx.userId,
          workspaceId: ctx.workspaceId,
          agentId: ctx.agentId,
          capability: req.capability,
          tool: req.tool,
          action: req.actionName,
          status: 'allowed',
          reason: `Pre-execution audit logging for ${riskLevel} action`,
          payload: { params: req.params, riskLevel }
        });
      } catch (err) {
        await rollbackReservation('failed');
        return {
          success: false,
          status: 'failed',
          error: `MANDATORY_AUDIT_LOG_FAILED: Could not write pre-execution audit record for ${riskLevel} risk action ${req.capability}`
        };
      }
    }

    // Consume approval only after the mandatory pre-execution audit succeeds.
    // A transient audit outage must not burn a valid user approval when no tool ran.
    if (policyResult.decision === 'require_approval' && req.approval) {
      if (this.repository) {
        const consumed = await this.repository.consumeApproval({
          approvalId: req.approval.approvalId,
          actionId: req.actionId,
          userId: ctx.userId,
          workspaceId: ctx.workspaceId,
          agentId: ctx.agentId
        });

        if (!consumed) {
          await rollbackReservation('failed');
          return {
            success: false,
            status: 'waiting_approval',
            error: 'APPROVAL_ALREADY_CONSUMED'
          };
        }
      }

      this.inMemoryConsumedApprovals.add(req.approval.approvalId);
    }

    // 5. Execute tool action with AbortSignal, Timeout, and Status Update
    const timeoutMs = req.timeoutMs ?? 30000;
    const timeoutController = new AbortController();
    let timeoutTimer: NodeJS.Timeout | undefined;

    const onAbort = () => timeoutController.abort();
    if (ctx.signal) {
      if (ctx.signal.aborted) onAbort();
      else ctx.signal.addEventListener('abort', onAbort, { once: true });
    }

    timeoutTimer = setTimeout(() => {
      timeoutController.abort();
    }, timeoutMs);

    try {
      const output = await toolExecutor(req.params, { signal: timeoutController.signal });

      clearTimeout(timeoutTimer);
      if (ctx.signal) ctx.signal.removeEventListener('abort', onAbort);

      // Record successful execution status
      if (this.repository) {
        await this.repository.updateActionStatus({
          actionId: req.actionId,
          userId: ctx.userId,
          workspaceId: ctx.workspaceId,
          agentId: ctx.agentId,
          status: 'executed'
        });
      }

      await this.auditLogger.log({
        actor: ctx.agentId,
        actorType: 'agent',
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
        agentId: ctx.agentId,
        capability: req.capability,
        tool: req.tool,
        action: req.actionName,
        status: 'executed',
        reason: 'Action executed successfully',
        payload: { params: req.params, result: output }
      });

      return {
        success: true,
        status: 'executed',
        result: output
      };
    } catch (err) {
      clearTimeout(timeoutTimer);
      if (ctx.signal) ctx.signal.removeEventListener('abort', onAbort);

      const isCancelled = ctx.signal?.aborted;
      const errorMsg = isCancelled ? 'ACTION_CANCELLED' : timeoutController.signal.aborted ? 'ACTION_TIMEOUT' : (err instanceof Error ? err.message : String(err));

      const finalStatus = isCancelled ? 'cancelled' : 'failed';
      await rollbackReservation(finalStatus);

      await this.auditLogger.log({
        actor: ctx.agentId,
        actorType: 'agent',
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
        agentId: ctx.agentId,
        capability: req.capability,
        tool: req.tool,
        action: req.actionName,
        status: 'failed',
        reason: errorMsg,
        payload: req.params
      });

      return {
        success: false,
        status: 'failed',
        error: errorMsg
      };
    }
  }
}
