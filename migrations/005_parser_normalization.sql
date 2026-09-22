BEGIN;

CREATE TABLE IF NOT EXISTS normalized_page_revisions (
  id BIGSERIAL PRIMARY KEY,
  provider_id TEXT NOT NULL,
  record_key TEXT NOT NULL,
  page_type TEXT NOT NULL CHECK (page_type IN ('school_index','school_history','season','game_log','box_score','game')),
  source_fetch_id BIGINT NOT NULL REFERENCES source_fetches(id),
  parser_name TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  data JSONB NOT NULL,
  provenance JSONB NOT NULL,
  disposition TEXT NOT NULL CHECK (disposition IN ('accepted','quarantined')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (record_key, source_fetch_id, parser_name, parser_version)
);
CREATE INDEX IF NOT EXISTS normalized_page_revisions_record_idx
  ON normalized_page_revisions (provider_id, record_key, created_at DESC);
CREATE INDEX IF NOT EXISTS normalized_page_revisions_quarantine_idx
  ON normalized_page_revisions (disposition, created_at) WHERE disposition = 'quarantined';

INSERT INTO schema_migrations(version) VALUES ('005_parser_normalization') ON CONFLICT (version) DO NOTHING;
COMMIT;
