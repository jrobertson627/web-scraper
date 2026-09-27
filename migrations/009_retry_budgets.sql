BEGIN;

-- Claim recovery has its own budget: a job whose claim expires this many times
-- without completing becomes permanently_failed instead of retrying forever.
ALTER TABLE crawl_jobs ADD COLUMN IF NOT EXISTS claim_recoveries INTEGER NOT NULL DEFAULT 0;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crawl_jobs_claim_recoveries_check') THEN
    ALTER TABLE crawl_jobs ADD CONSTRAINT crawl_jobs_claim_recoveries_check CHECK (claim_recoveries >= 0);
  END IF;
END $$;

INSERT INTO schema_migrations(version) VALUES ('009_retry_budgets') ON CONFLICT DO NOTHING;
COMMIT;
