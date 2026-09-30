BEGIN;

-- A run halt that is not one page's (#114): the raw disk is full or nearly so,
-- requests keep failing across different pages, the database is out of storage.
-- A halt stays until an operator releases it, so a restarted worker makes no
-- request either: the same rule as a challenge stop, which lives on its job.
CREATE TABLE IF NOT EXISTS run_halts (
  id BIGSERIAL PRIMARY KEY,
  reason TEXT NOT NULL,
  detail TEXT,
  raised_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  released_at TIMESTAMPTZ,
  released_by TEXT,
  release_reason TEXT,
  CHECK ((released_at IS NULL) = (released_by IS NULL))
);
CREATE INDEX IF NOT EXISTS run_halts_unreleased_idx ON run_halts (id) WHERE released_at IS NULL;

-- An operator can put a permanently_failed page back in the queue with a fresh
-- failure budget (requeue_failed), recorded like every other disposition.
ALTER TABLE operator_dispositions DROP CONSTRAINT IF EXISTS operator_dispositions_disposition_check;
ALTER TABLE operator_dispositions ADD CONSTRAINT operator_dispositions_disposition_check
  CHECK (disposition IN ('hold','release_retry','release_permanent','requeue_failed'));

INSERT INTO schema_migrations(version) VALUES ('016_run_halts') ON CONFLICT (version) DO NOTHING;
COMMIT;
