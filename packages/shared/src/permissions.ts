export type Capability =
  | 'web.read'
  | 'web.navigate'
  | 'web.search'
  | 'web.form.fill'
  | 'web.click'
  | 'screen.capture'
  | 'screen.observe'
  | 'device.files.read'
  | 'device.files.write'
  | 'device.camera.use'
  | 'device.microphone.use'
  | 'device.location.read'
  | 'calendar.read'
  | 'calendar.create'
  | 'calendar.update'
  | 'contacts.read'
  | 'application.read'
  | 'application.write'
  | 'ai.generate'
  | 'ai.execute'
  | 'ai.analyze';

export type CapabilityNamespace =
  | 'web'
  | 'screen'
  | 'device'
  | 'calendar'
  | 'contacts'
  | 'application'
  | 'ai';

export type CapabilityGrant = Capability | `${CapabilityNamespace}.*`;

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type PolicyDecision = 'allow' | 'deny' | 'require_approval';

export interface PermissionCheckRequest {
  userId: string;
  workspaceId?: string;
  agentId?: string;
  capability: Capability;
  scope?: Record<string, unknown>;
}

export interface PermissionCheckResult {
  granted: boolean;
  reason?: string;
  permissionId?: string;
}

export interface PolicyCheckRequest {
  workspaceId?: string;
  capability: Capability;
  tool?: string;
  riskLevel?: RiskLevel;
}

export interface PolicyCheckResult {
  decision: PolicyDecision;
  riskLevel: RiskLevel;
  reason?: string;
}

export interface AuditLogInput {
  requestId?: string;
  actor: string;
  actorType: 'user' | 'agent' | 'system';
  userId?: string;
  workspaceId?: string;
  agentId?: string;
  applicationId?: string;
  capability: Capability;
  tool?: string;
  action: string;
  status: 'allowed' | 'denied' | 'approved' | 'rejected' | 'failed' | 'executed';
  reason?: string;
  payload?: Record<string, unknown>;
}
