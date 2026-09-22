BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crawl_jobs_claim_state_check') THEN
    ALTER TABLE crawl_jobs ADD CONSTRAINT crawl_jobs_claim_state_check
      CHECK ((state IN ('fetching','fetched')) OR (claim_owner IS NULL AND claim_expires_at IS NULL AND lease_generation IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crawl_jobs_lease_generation_check') THEN
    ALTER TABLE crawl_jobs ADD CONSTRAINT crawl_jobs_lease_generation_check
      CHECK (lease_generation IS NULL OR lease_generation > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'source_fetches_raw_reference_check') THEN
    ALTER TABLE source_fetches ADD CONSTRAINT source_fetches_raw_reference_check
      CHECK (((http_status < 200 OR http_status >= 300) AND http_status <> 304) OR (checksum IS NOT NULL AND raw_object_path IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'source_fetches_checksum_check') THEN
    ALTER TABLE source_fetches ADD CONSTRAINT source_fetches_checksum_check
      CHECK (checksum IS NULL OR checksum ~ '^[0-9a-f]{64}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'in_flight_requests_outcome_release_check') THEN
    ALTER TABLE in_flight_requests ADD CONSTRAINT in_flight_requests_outcome_release_check
      CHECK ((released_at IS NULL AND outcome IS NULL) OR (released_at IS NOT NULL AND outcome IN ('completed','canceled')));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'raw_object_repair_checksum_check') THEN
    ALTER TABLE raw_object_repair ADD CONSTRAINT raw_object_repair_checksum_check
      CHECK (checksum ~ '^[0-9a-f]{64}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'publication_policies_redistribution_check') THEN
    ALTER TABLE publication_policies ADD CONSTRAINT publication_policies_redistribution_check
      CHECK (redistribution IN ('private','public'));
  END IF;
END $$;

ALTER TABLE raw_object_repair ADD COLUMN IF NOT EXISTS reason TEXT;
ALTER TABLE raw_object_repair ADD COLUMN IF NOT EXISTS source_fetch_ids JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE raw_object_repair ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

UPDATE school_seasons SET provenance = '{}'::jsonb WHERE provenance IS NULL;
ALTER TABLE school_seasons ALTER COLUMN provenance SET DEFAULT '{}'::jsonb;
ALTER TABLE school_seasons ALTER COLUMN provenance SET NOT NULL;
UPDATE unavailable_coverage SET provenance = '{}'::jsonb WHERE provenance IS NULL;
ALTER TABLE unavailable_coverage ALTER COLUMN provenance SET DEFAULT '{}'::jsonb;
ALTER TABLE unavailable_coverage ALTER COLUMN provenance SET NOT NULL;

CREATE INDEX IF NOT EXISTS source_fetches_checksum_idx ON source_fetches (checksum) WHERE checksum IS NOT NULL;
CREATE INDEX IF NOT EXISTS raw_object_repair_state_idx ON raw_object_repair (state, observed_at);
CREATE INDEX IF NOT EXISTS parse_runs_source_fetch_idx ON parse_runs (source_fetch_id, parsed_at DESC);
CREATE INDEX IF NOT EXISTS game_observations_parent_idx ON game_observations (parent_job_id, source_row_index);
CREATE INDEX IF NOT EXISTS reconciliation_issues_record_idx ON reconciliation_issues (record_key, status);

INSERT INTO schema_migrations(version) VALUES ('004_schema_hardening') ON CONFLICT (version) DO NOTHING;
COMMIT;
