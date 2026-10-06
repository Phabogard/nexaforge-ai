import type { Capability, RiskLevel } from '@nexaforge/shared';

export interface ToolDefinition {
  name: string;
  version: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  capabilities: Capability[];
  riskLevel: RiskLevel;
  timeoutMs: number;
  sideEffects: boolean;
  idempotent: boolean;
}
