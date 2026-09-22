BEGIN;

CREATE TABLE IF NOT EXISTS job_state_events (
  id BIGSERIAL PRIMARY KEY,
  job_id BIGINT NOT NULL REFERENCES crawl_jobs(id),
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  attempts INTEGER NOT NULL CHECK (attempts >= 0),
  lease_generation BIGINT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  transitioned_at TIMESTAMPTZ NOT NULL,
  CHECK (from_state IN ('pending','fetching','fetched','parsed','retry_wait','permanently_failed','parse_failed','operator_stop')),
  CHECK (to_state IN ('pending','fetching','fetched','parsed','retry_wait','permanently_failed','parse_failed','operator_stop'))
);
CREATE INDEX IF NOT EXISTS job_state_events_job_idx ON job_state_events (job_id, transitioned_at);

ALTER TABLE in_flight_requests ADD COLUMN IF NOT EXISTS outcome TEXT;
ALTER TABLE in_flight_requests ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'in_flight_requests_outcome_check') THEN
    ALTER TABLE in_flight_requests ADD CONSTRAINT in_flight_requests_outcome_check
      CHECK (outcome IS NULL OR outcome IN ('completed','canceled')) NOT VALID;
  END IF;
END $$;

INSERT INTO schema_migrations(version) VALUES ('002_job_lifecycle') ON CONFLICT DO NOTHING;
COMMIT;
