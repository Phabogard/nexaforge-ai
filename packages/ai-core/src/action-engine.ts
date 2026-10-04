import type { Capability, RiskLevel, PolicyDecision } from '@nexaforge/shared';
import { CapabilityEngine } from './capability-engine.js';
import { PermissionEngine } from './permission-engine.js';
import { PolicyEngine } from './policy-engine.js';
import { AuditLogger } from './audit-logger.js';
import type { AgentExecutionContext } from './agent-runtime.js';

export interface ActionApproval {
  approvalId: string;
  userId: string;
  actionId: string;
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
}

export interface ActionExecutionResult {
  success: boolean;
  status: 'executed' | 'denied' | 'waiting_approval' | 'failed';
  preview?: ActionPreview;
  result?: unknown;
  error?: string;
}

export class ActionEngine {
  private executedActionIds: Map<string, number> = new Map();

  constructor(
    private permissionEngine: PermissionEngine,
    private policyEngine: PolicyEngine,
    private auditLogger: AuditLogger
  ) {}

  async executeAction(
    ctx: AgentExecutionContext,
    req: ActionExecutionRequest,
    toolExecutor?: (params: Record<string, unknown>) => Promise<unknown>
  ): Promise<ActionExecutionResult> {
    // Check timeout / cancellation signal early
    if (ctx.signal?.aborted) {
      return {
        success: false,
        status: 'failed',
        error: 'ACTION_CANCELLED'
      };
    }

    // 0. Fail-closed if no real toolExecutor provided
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

    // 0.1 Action Replay Protection
    if (this.executedActionIds.has(req.actionId)) {
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

    // 3. Handle required approval for HIGH / CRITICAL actions with structured verification
    if (policyResult.decision === 'require_approval') {
      const approval = req.approval;

      if (
        !approval ||
        approval.decision !== 'approved' ||
        approval.actionId !== req.actionId ||
        approval.userId !== ctx.userId ||
        Date.now() > approval.expiresAt
      ) {
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
          reason: 'Action requires valid signed user approval',
          payload: { preview }
        });

        return {
          success: false,
          status: 'waiting_approval',
          preview,
          error: 'EXPLICIT_APPROVAL_REQUIRED'
        };
      }
    }

    // 4. Execute tool action with cancellation support and replay tracking
    try {
      this.executedActionIds.set(req.actionId, Date.now());

      const output = await toolExecutor(req.params);

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
      const errorMsg = err instanceof Error ? err.message : String(err);

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
