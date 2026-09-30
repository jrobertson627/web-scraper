BEGIN;

-- A season rollover refresh (#154). When the season rolls over, an operator puts
-- the parsed school index and school histories back in the queue so the new
-- season is discovered. refresh_requested_at marks a job whose next parse should
-- replace its accepted record instead of being held as a conflicting revision,
-- since a changed page is what the refresh is for. It is cleared when the page is
-- parsed. The requests themselves are recorded like every other operator
-- disposition.
ALTER TABLE crawl_jobs ADD COLUMN IF NOT EXISTS refresh_requested_at TIMESTAMPTZ;

ALTER TABLE operator_dispositions DROP CONSTRAINT IF EXISTS operator_dispositions_disposition_check;
ALTER TABLE operator_dispositions ADD CONSTRAINT operator_dispositions_disposition_check
  CHECK (disposition IN ('hold','release_retry','release_permanent','requeue_failed','refresh'));

INSERT INTO schema_migrations(version) VALUES ('019_refresh_requested') ON CONFLICT (version) DO NOTHING;
COMMIT;
