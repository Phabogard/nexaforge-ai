import type { PolicyCheckRequest, PolicyCheckResult, RiskLevel, PolicyDecision } from '@nexaforge/shared';
import type { PermissionRepository } from '@nexaforge/db';
import { CapabilityEngine } from './capability-engine.js';

export class PolicyEngine {
  constructor(private repository?: PermissionRepository | null) {}

  async evaluatePolicy(req: PolicyCheckRequest): Promise<PolicyCheckResult> {
    const riskLevel: RiskLevel = req.riskLevel ?? CapabilityEngine.getRiskLevel(req.capability);

    // 1. Check DB custom policy if available
    if (this.repository) {
      const customPolicy = await this.repository.getPolicy(req.capability, req.workspaceId);
      if (customPolicy) {
        return {
          decision: customPolicy.policyAction as PolicyDecision,
          riskLevel: customPolicy.riskLevel as RiskLevel,
          reason: 'Custom security policy applied'
        };
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
