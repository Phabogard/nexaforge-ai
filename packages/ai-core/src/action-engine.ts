import type { Capability, RiskLevel, PolicyDecision } from '@nexaforge/shared';
import { CapabilityEngine } from './capability-engine.js';
import { PermissionEngine } from './permission-engine.js';
import { PolicyEngine } from './policy-engine.js';
import { AuditLogger } from './audit-logger.js';
import type { AgentExecutionContext } from './agent-runtime.js';

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
  userApproved?: boolean;
}

export interface ActionExecutionResult {
  success: boolean;
  status: 'executed' | 'denied' | 'waiting_approval' | 'failed';
  preview?: ActionPreview;
  result?: unknown;
  error?: string;
}

export class ActionEngine {
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

    // 3. Handle required approval for HIGH / CRITICAL actions
    if (policyResult.decision === 'require_approval' && !req.userApproved) {
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
        reason: 'Action requires explicit user approval',
        payload: { preview }
      });

      return {
        success: false,
        status: 'waiting_approval',
        preview,
        error: 'EXPLICIT_APPROVAL_REQUIRED'
      };
    }

    // 4. Execute tool action
    try {
      const output = toolExecutor ? await toolExecutor(req.params) : { ok: true };

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
