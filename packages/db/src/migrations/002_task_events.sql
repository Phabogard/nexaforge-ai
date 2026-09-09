CREATE INDEX IF NOT EXISTS task_events_type_created_idx
  ON task_events(task_id, event_type, created_at);

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS result jsonb,
  ADD COLUMN IF NOT EXISTS error_code text,
  ADD COLUMN IF NOT EXISTS iteration_count integer NOT NULL DEFAULT 0;
