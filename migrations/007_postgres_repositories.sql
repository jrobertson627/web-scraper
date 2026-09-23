BEGIN;

-- The active lease columns are cleared on retry/terminal transitions. Keep the
-- monotonic fencing generation independently so a later claim cannot reuse it.
ALTER TABLE crawl_jobs ADD COLUMN IF NOT EXISTS claim_generation BIGINT NOT NULL DEFAULT 0;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crawl_jobs_claim_generation_check') THEN
    ALTER TABLE crawl_jobs ADD CONSTRAINT crawl_jobs_claim_generation_check
      CHECK (claim_generation >= 0);
  END IF;
END $$;
UPDATE crawl_jobs SET claim_generation = GREATEST(claim_generation, COALESCE(lease_generation, 0));

-- Latest game observations stay in game_observations. Every source revision,
-- including a rejected reparse, is retained here for provenance and review.
CREATE TABLE IF NOT EXISTS page_observation_revisions (
  id BIGSERIAL PRIMARY KEY,
  job_id BIGINT NOT NULL REFERENCES crawl_jobs(id),
  observation_key TEXT NOT NULL,
  source_fetch_id BIGINT NOT NULL REFERENCES source_fetches(id),
  observation JSONB NOT NULL,
  accepted BOOLEAN NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (job_id, observation_key, source_fetch_id)
);
CREATE INDEX IF NOT EXISTS page_observation_revisions_job_idx
  ON page_observation_revisions (job_id, observation_key, recorded_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS one_active_request_per_job
  ON in_flight_requests (job_id) WHERE released_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS one_open_reconciliation_fact
  ON reconciliation_issues (issue_type, record_key, (md5(details::text))) WHERE status = 'open';

INSERT INTO schema_migrations(version) VALUES ('007_postgres_repositories') ON CONFLICT DO NOTHING;
COMMIT;
