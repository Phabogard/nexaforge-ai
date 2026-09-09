CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  display_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  owner_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  prompt text NOT NULL,
  mode text NOT NULL,
  status text NOT NULL,
  max_iterations integer NOT NULL DEFAULT 12,
  budget_cents integer,
  result jsonb,
  error_code text,
  iteration_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE task_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  url text NOT NULL,
  title text,
  publisher text,
  published_at timestamptz,
  retrieved_at timestamptz NOT NULL DEFAULT now(),
  reliability_score numeric(5,2),
  content_hash text
);

CREATE TABLE claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid REFERENCES tasks(id) ON DELETE CASCADE,
  text text NOT NULL,
  status text NOT NULL,
  confidence numeric(5,2),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid NOT NULL REFERENCES sources(id),
  claim_id uuid REFERENCES claims(id) ON DELETE CASCADE,
  excerpt text NOT NULL,
  retrieved_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE connectors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider text NOT NULL,
  status text NOT NULL DEFAULT 'disconnected',
  permissions jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, provider)
);

CREATE TABLE memories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind text NOT NULL,
  content text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE usage_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id uuid REFERENCES tasks(id),
  provider text,
  model text,
  input_tokens integer DEFAULT 0,
  output_tokens integer DEFAULT 0,
  cost_cents integer DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX tasks_workspace_created_idx ON tasks(workspace_id, created_at DESC);
CREATE INDEX task_events_task_created_idx ON task_events(task_id, created_at);
CREATE INDEX task_events_type_created_idx ON task_events(task_id, event_type, created_at);
CREATE INDEX evidence_claim_idx ON evidence(claim_id);
CREATE INDEX memories_workspace_created_idx ON memories(workspace_id, created_at DESC);
CREATE INDEX usage_workspace_created_idx ON usage_records(workspace_id, created_at DESC);
