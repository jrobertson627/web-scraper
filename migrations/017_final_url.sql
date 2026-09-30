BEGIN;

-- The URL a fetch ended at after following redirects (#124), when it is not the
-- URL the job was queued under. A page's links are resolved against it, and a
-- redirect to a different page stops for review with both URLs on record.
ALTER TABLE source_fetches ADD COLUMN IF NOT EXISTS final_url TEXT;

INSERT INTO schema_migrations(version) VALUES ('017_final_url') ON CONFLICT (version) DO NOTHING;
COMMIT;
