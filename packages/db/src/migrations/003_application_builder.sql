CREATE TABLE IF NOT EXISTS application_projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'building', 'ready', 'failed', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS application_projects_workspace_idx
  ON application_projects(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS application_project_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES application_projects(id) ON DELETE CASCADE,
  version integer NOT NULL,
  blueprint jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id, version)
);

CREATE TABLE IF NOT EXISTS application_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_version_id uuid NOT NULL REFERENCES application_project_versions(id) ON DELETE CASCADE,
  path text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('source', 'config', 'asset', 'generated')),
  content_hash text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_version_id, path)
);

CREATE INDEX IF NOT EXISTS application_artifacts_version_idx
  ON application_artifacts(project_version_id);

CREATE TABLE IF NOT EXISTS application_builds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES application_projects(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued',
  phase text NOT NULL DEFAULT 'queued',
  request jsonb NOT NULL,
  result jsonb,
  error_code text,
  repair_attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS application_builds_project_created_idx
  ON application_builds(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS application_build_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  build_id uuid NOT NULL REFERENCES application_builds(id) ON DELETE CASCADE,
  step_key text NOT NULL,
  phase text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  attempt integer NOT NULL DEFAULT 0,
  input jsonb,
  output jsonb,
  error_code text,
  started_at timestamptz,
  completed_at timestamptz,
  UNIQUE(build_id, step_key)
);

CREATE INDEX IF NOT EXISTS application_build_steps_build_idx
  ON application_build_steps(build_id, started_at);

CREATE TABLE IF NOT EXISTS application_deployments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES application_projects(id) ON DELETE CASCADE,
  build_id uuid REFERENCES application_builds(id) ON DELETE SET NULL,
  provider text NOT NULL,
  environment text NOT NULL DEFAULT 'production',
  status text NOT NULL DEFAULT 'queued',
  external_id text,
  url text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS application_deployments_project_idx
  ON application_deployments(project_id, created_at DESC);
