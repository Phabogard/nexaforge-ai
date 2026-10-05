CREATE TABLE IF NOT EXISTS permissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR(128) NOT NULL,
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id VARCHAR(128),
  capability VARCHAR(128) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'granted' CHECK (status IN ('granted', 'revoked', 'denied', 'expired')),
  scope JSONB DEFAULT '{}'::jsonb,
  expires_at TIMESTAMPTZ,
  granted_by VARCHAR(128),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_permissions_user_cap ON permissions(user_id, capability, status);
CREATE INDEX IF NOT EXISTS idx_permissions_workspace ON permissions(workspace_id);

CREATE TABLE IF NOT EXISTS consent_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR(128) NOT NULL,
  capability VARCHAR(128) NOT NULL,
  action VARCHAR(128) NOT NULL,
  decision VARCHAR(32) NOT NULL CHECK (decision IN ('granted', 'denied')),
  context JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_consent_user_cap ON consent_records(user_id, capability);

CREATE TABLE IF NOT EXISTS security_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  capability VARCHAR(128) NOT NULL,
  risk_level VARCHAR(32) NOT NULL DEFAULT 'MEDIUM' CHECK (risk_level IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  policy_action VARCHAR(32) NOT NULL DEFAULT 'require_approval' CHECK (policy_action IN ('allow', 'deny', 'require_approval')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_security_policies_workspace ON security_policies(workspace_id, capability);

CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id VARCHAR(128),
  actor VARCHAR(128) NOT NULL,
  actor_type VARCHAR(64) NOT NULL CHECK (actor_type IN ('user', 'agent', 'system')),
  user_id VARCHAR(128),
  workspace_id UUID REFERENCES workspaces(id) ON DELETE SET NULL,
  agent_id VARCHAR(128),
  application_id UUID,
  capability VARCHAR(128) NOT NULL,
  tool VARCHAR(128),
  action VARCHAR(128) NOT NULL,
  status VARCHAR(32) NOT NULL CHECK (status IN ('allowed', 'denied', 'approved', 'rejected', 'failed', 'executed')),
  reason TEXT,
  payload JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_user ON audit_logs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_workspace ON audit_logs(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_capability ON audit_logs(capability);

CREATE TABLE IF NOT EXISTS agent_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR(128) NOT NULL,
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_type VARCHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'revoked')),
  granted_capabilities JSONB DEFAULT '[]'::jsonb,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_agent_sessions_user ON agent_sessions(user_id, status);

CREATE TABLE IF NOT EXISTS consumed_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  approval_id VARCHAR(128) NOT NULL UNIQUE,
  action_id VARCHAR(128) NOT NULL,
  user_id VARCHAR(128) NOT NULL,
  workspace_id UUID REFERENCES workspaces(id) ON DELETE SET NULL,
  agent_id VARCHAR(128),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_consumed_approvals_user ON consumed_approvals(user_id, action_id);

CREATE TABLE IF NOT EXISTS executed_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action_id VARCHAR(128) NOT NULL UNIQUE,
  user_id VARCHAR(128) NOT NULL,
  workspace_id UUID REFERENCES workspaces(id) ON DELETE SET NULL,
  agent_id VARCHAR(128),
  status VARCHAR(32) NOT NULL CHECK (status IN ('pending', 'executed', 'failed', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_executed_actions_action_user ON executed_actions(action_id, user_id);
