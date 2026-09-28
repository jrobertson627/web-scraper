BEGIN;

-- 001 declared an unnamed CHECK that a job holds all three claim columns exactly
-- when it is fetching or fetched, and 004 added crawl_jobs_claim_state_check that
-- every other state holds none of them. Together they mean: fetching or fetched
-- jobs hold a complete claim, and no other job holds any part of one. This
-- replaces both with that single rule under the 004 name. After the first run
-- the unnamed constraint is gone (001's CREATE TABLE IF NOT EXISTS never
-- recreates it), so a repeat run changes nothing.
DO $$
DECLARE
  legacy TEXT;
BEGIN
  SELECT conname INTO legacy FROM pg_constraint
    WHERE conrelid = 'crawl_jobs'::regclass AND contype = 'c'
      AND conname <> 'crawl_jobs_claim_state_check'
      AND pg_get_constraintdef(oid) LIKE '%claim_owner IS NOT NULL%';
  IF legacy IS NOT NULL THEN
    EXECUTE format('ALTER TABLE crawl_jobs DROP CONSTRAINT %I', legacy);
    ALTER TABLE crawl_jobs DROP CONSTRAINT IF EXISTS crawl_jobs_claim_state_check;
    ALTER TABLE crawl_jobs ADD CONSTRAINT crawl_jobs_claim_state_check CHECK (
      CASE WHEN state IN ('fetching','fetched')
        THEN claim_owner IS NOT NULL AND claim_expires_at IS NOT NULL AND lease_generation IS NOT NULL
        ELSE claim_owner IS NULL AND claim_expires_at IS NULL AND lease_generation IS NULL
      END);
  END IF;
END $$;

INSERT INTO schema_migrations(version) VALUES ('011_claim_check_consolidation') ON CONFLICT (version) DO NOTHING;
COMMIT;
