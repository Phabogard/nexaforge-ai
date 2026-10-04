import type { PolicyCheckRequest, PolicyCheckResult, RiskLevel, PolicyDecision } from '@nexaforge/shared';
import type { PermissionRepository } from '@nexaforge/db';
import { CapabilityEngine } from './capability-engine.js';

const VALID_RISK_LEVELS = new Set<RiskLevel>(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
const VALID_POLICY_DECISIONS = new Set<PolicyDecision>(['allow', 'deny', 'require_approval']);

export class PolicyEngine {
  constructor(private repository?: PermissionRepository | null) {}

  async evaluatePolicy(req: PolicyCheckRequest): Promise<PolicyCheckResult> {
    let riskLevel: RiskLevel = req.riskLevel ?? CapabilityEngine.getRiskLevel(req.capability);
    if (!VALID_RISK_LEVELS.has(riskLevel)) {
      riskLevel = 'HIGH'; // Fallback to HIGH risk if invalid risk level supplied
    }

    // 1. Check DB custom policy if available
    if (this.repository) {
      const customPolicy = await this.repository.getPolicy(req.capability, req.workspaceId);
      if (customPolicy) {
        const policyAction = customPolicy.policyAction as PolicyDecision;
        const customRisk = customPolicy.riskLevel as RiskLevel;

        if (VALID_POLICY_DECISIONS.has(policyAction) && VALID_RISK_LEVELS.has(customRisk)) {
          return {
            decision: policyAction,
            riskLevel: customRisk,
            reason: 'Custom security policy applied'
          };
        }
      }
    }

    // 2. Default policy based on risk classification
    if (riskLevel === 'CRITICAL') {
      return {
        decision: 'require_approval',
        riskLevel,
        reason: 'CRITICAL actions strictly require explicit user approval'
      };
    }

    if (riskLevel === 'HIGH') {
      return {
        decision: 'require_approval',
        riskLevel,
        reason: 'HIGH risk actions require explicit user approval'
      };
    }

    if (riskLevel === 'MEDIUM') {
      return {
        decision: 'allow',
        riskLevel,
        reason: 'MEDIUM risk actions are allowed when capability permission is granted'
      };
    }

    return {
      decision: 'allow',
      riskLevel: 'LOW',
      reason: 'LOW risk action allowed'
    };
  }
}
