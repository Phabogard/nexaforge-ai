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

export class ActionEngine {
  private inMemoryExecutedActions: Set<string> = new Set();
  private inMemoryConsumedApprovals: Set<string> = new Set();

  constructor(
    private permissionEngine: PermissionEngine,
    private policyEngine: PolicyEngine,
    private auditLogger: AuditLogger,
    private repository?: PermissionRepository | null
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

    // 0.2 Action Replay Protection (DB + In-Memory)
    let isAlreadyExecuted = this.inMemoryExecutedActions.has(req.actionId);
    if (!isAlreadyExecuted && this.repository) {
      isAlreadyExecuted = await this.repository.isActionExecuted(req.actionId);
    }

    if (isAlreadyExecuted) {
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

    const riskLevel = CapabilityEngine.getRiskLevel(req.capability);

    // 1. Check capability permission
    const permResult = await this.permissionEngine.checkPermission({
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
      agentId: ctx.agentId,
      capability: req.capability
    });

    if (!permResult.granted) {
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

    // 3. Handle required approval with single-use consumption and scope verification
    if (policyResult.decision === 'require_approval') {
      const approval = req.approval;

      const isValidApproval =
        approval &&
        approval.decision === 'approved' &&
        approval.actionId === req.actionId &&
        approval.userId === ctx.userId &&
        (!approval.workspaceId || !ctx.workspaceId || approval.workspaceId === ctx.workspaceId) &&
        (!approval.agentId || !ctx.agentId || approval.agentId === ctx.agentId) &&
        (!approval.capability || approval.capability === req.capability) &&
        Date.now() <= approval.expiresAt &&
        !this.inMemoryConsumedApprovals.has(approval.approvalId);

      if (!isValidApproval) {
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
          reason: 'Action requires valid unused matching user approval',
          payload: { preview }
        });

        return {
          success: false,
          status: 'waiting_approval',
          preview,
          error: 'EXPLICIT_APPROVAL_REQUIRED'
        };
      }

      // Try consuming approval atomically in DB if repository available
      if (this.repository) {
        const consumed = await this.repository.consumeApproval({
          approvalId: approval.approvalId,
          actionId: req.actionId,
          userId: ctx.userId,
          workspaceId: ctx.workspaceId,
          agentId: ctx.agentId
        });

        if (!consumed) {
          return {
            success: false,
            status: 'waiting_approval',
            error: 'APPROVAL_ALREADY_CONSUMED'
          };
        }
      }

      this.inMemoryConsumedApprovals.add(approval.approvalId);
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
        return {
          success: false,
          status: 'failed',
          error: `MANDATORY_AUDIT_LOG_FAILED: Could not write pre-execution audit record for ${riskLevel} risk action ${req.capability}`
        };
      }
    }

    // 5. Execute tool action with AbortSignal, Timeout, and Persistent Replay tracking
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

      // Record successful execution
      this.inMemoryExecutedActions.add(req.actionId);
      if (this.repository) {
        await this.repository.recordExecutedAction({
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
