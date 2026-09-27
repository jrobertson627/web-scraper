BEGIN;

-- Separate retry budgets (see JOB_LIFECYCLE.md). attempts still counts every
-- claim; only these counters decide when a job stops retrying.
--   failure_attempts:    transport errors, 5xx and fetch-phase infrastructure
--                        errors, capped by the request policy's maxAttempts.
--   rate_limit_attempts: 429 responses, capped by maxRateLimitAttempts, which
--                        escalates to operator_stop.
--   claim_recoveries:    expired claims recovered without completing; a job
--                        becomes permanently_failed at maxClaimRecoveries.
ALTER TABLE crawl_jobs ADD COLUMN IF NOT EXISTS failure_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE crawl_jobs ADD COLUMN IF NOT EXISTS rate_limit_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE crawl_jobs ADD COLUMN IF NOT EXISTS claim_recoveries INTEGER NOT NULL DEFAULT 0;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crawl_jobs_retry_budgets_check') THEN
    ALTER TABLE crawl_jobs ADD CONSTRAINT crawl_jobs_retry_budgets_check
      CHECK (failure_attempts >= 0 AND rate_limit_attempts >= 0 AND claim_recoveries >= 0);
  END IF;
END $$;

-- The long-running worker walks the job tree from the roots to decide whether
-- any runnable work remains.
CREATE INDEX IF NOT EXISTS crawl_jobs_parent_idx ON crawl_jobs (parent_job_id);

INSERT INTO schema_migrations(version) VALUES ('009_worker_robustness') ON CONFLICT DO NOTHING;
COMMIT;
