BEGIN;

ALTER TABLE source_fetches ADD COLUMN IF NOT EXISTS cache_control TEXT;
ALTER TABLE source_fetches ADD COLUMN IF NOT EXISTS cache_hit BOOLEAN NOT NULL DEFAULT FALSE;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'source_fetches_cache_hit_reuse_check') THEN
    ALTER TABLE source_fetches ADD CONSTRAINT source_fetches_cache_hit_reuse_check
      CHECK (NOT cache_hit OR reused_body);
  END IF;
END $$;

INSERT INTO schema_migrations(version) VALUES ('006_http_cache_metadata') ON CONFLICT (version) DO NOTHING;
COMMIT;
