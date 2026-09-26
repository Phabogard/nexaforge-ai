-- Worker leases make long-running application builds and deployments recoverable after worker crashes.
ALTER TABLE application_builds
  ADD COLUMN IF NOT EXISTS lease_owner TEXT,
  ADD COLUMN IF NOT EXISTS lease_until TIMESTAMPTZ;

ALTER TABLE application_deployments
  ADD COLUMN IF NOT EXISTS lease_owner TEXT,
  ADD COLUMN IF NOT EXISTS lease_until TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS application_builds_lease_idx
  ON application_builds (status, lease_until);

CREATE INDEX IF NOT EXISTS application_deployments_lease_idx
  ON application_deployments (status, lease_until);
