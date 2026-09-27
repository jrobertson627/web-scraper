BEGIN;

-- Open reconciliation issues were deduplicated on md5(details). Details carry
-- provenance (source fetch ids, parse times), so every refetch of an unchanged
-- conflicting page opened a new duplicate issue. Deduplicate on a stable key
-- that the writer derives from the conflicting facts instead; details stay as
-- the full evidence of the first occurrence.
ALTER TABLE reconciliation_issues ADD COLUMN IF NOT EXISTS dedup_key TEXT;

-- Existing rows keep the old identity, which is still unique among open rows.
UPDATE reconciliation_issues SET dedup_key = 'legacy:' || md5(details::text) WHERE dedup_key IS NULL;
ALTER TABLE reconciliation_issues ALTER COLUMN dedup_key SET NOT NULL;

DROP INDEX IF EXISTS one_open_reconciliation_fact;
CREATE UNIQUE INDEX IF NOT EXISTS one_open_reconciliation_issue
  ON reconciliation_issues (issue_type, record_key, dedup_key) WHERE status = 'open';

INSERT INTO schema_migrations(version) VALUES ('010_reconciliation_issue_dedup') ON CONFLICT (version) DO NOTHING;
COMMIT;
