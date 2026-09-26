CREATE TABLE IF NOT EXISTS application_build_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  build_id uuid NOT NULL REFERENCES application_builds(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  phase text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS application_build_events_build_created_idx
  ON application_build_events(build_id, created_at ASC);

CREATE TABLE IF NOT EXISTS application_build_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  build_id uuid NOT NULL REFERENCES application_builds(id) ON DELETE CASCADE,
  step_key text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),
  reason text NOT NULL DEFAULT '',
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(build_id, step_key)
);

CREATE INDEX IF NOT EXISTS application_build_approvals_build_idx
  ON application_build_approvals(build_id, created_at ASC);

CREATE INDEX IF NOT EXISTS application_builds_status_created_idx
  ON application_builds(status, created_at ASC);
