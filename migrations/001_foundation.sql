BEGIN;

CREATE TABLE IF NOT EXISTS crawl_jobs (
  id BIGSERIAL PRIMARY KEY,
  provider_id TEXT NOT NULL,
  canonical_path TEXT NOT NULL,
  page_type TEXT NOT NULL CHECK (page_type IN ('school_index','school_history','season','game_log','box_score')),
  source_url TEXT NOT NULL,
  parent_job_id BIGINT REFERENCES crawl_jobs(id),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','fetching','fetched','parsed','retry_wait','permanently_failed','parse_failed','operator_stop')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_allowed_at TIMESTAMPTZ,
  last_error TEXT,
  claim_owner TEXT,
  claim_expires_at TIMESTAMPTZ,
  lease_generation BIGINT,
  UNIQUE (provider_id, canonical_path, page_type)
);

CREATE TABLE IF NOT EXISTS source_fetches (
  id BIGSERIAL PRIMARY KEY,
  job_id BIGINT NOT NULL REFERENCES crawl_jobs(id),
  provider_id TEXT NOT NULL,
  canonical_path TEXT NOT NULL,
  http_status INTEGER NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL,
  etag TEXT,
  last_modified TEXT,
  checksum TEXT,
  raw_object_path TEXT,
  reused_body BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE (provider_id, canonical_path, fetched_at)
);

CREATE TABLE IF NOT EXISTS parse_runs (
  id BIGSERIAL PRIMARY KEY,
  job_id BIGINT NOT NULL REFERENCES crawl_jobs(id),
  source_fetch_id BIGINT NOT NULL REFERENCES source_fetches(id),
  parser_name TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('valid','structural_failure')),
  warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
  failure_details JSONB,
  parsed_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS schools (
  id BIGSERIAL PRIMARY KEY,
  provider_id TEXT NOT NULL,
  canonical_source_path TEXT NOT NULL,
  display_name TEXT NOT NULL,
  city TEXT,
  state TEXT,
  eligible BOOLEAN NOT NULL,
  provenance JSONB NOT NULL,
  UNIQUE (provider_id, canonical_source_path)
);
CREATE TABLE IF NOT EXISTS school_aliases (
  id BIGSERIAL PRIMARY KEY,
  school_id BIGINT NOT NULL REFERENCES schools(id),
  alias TEXT NOT NULL,
  UNIQUE (school_id, alias)
);
CREATE TABLE IF NOT EXISTS school_seasons (
  id BIGSERIAL PRIMARY KEY,
  school_id BIGINT NOT NULL REFERENCES schools(id),
  ending_year INTEGER NOT NULL CHECK (ending_year BETWEEN 2022 AND 2026),
  coverage_status TEXT NOT NULL CHECK (coverage_status IN ('linked','unavailable')),
  provenance JSONB,
  UNIQUE (school_id, ending_year)
);
CREATE TABLE IF NOT EXISTS season_rosters (
  id BIGSERIAL PRIMARY KEY,
  school_season_id BIGINT NOT NULL REFERENCES school_seasons(id),
  player_source_path TEXT,
  player_name TEXT NOT NULL,
  provenance JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS players (
  id BIGSERIAL PRIMARY KEY,
  provider_id TEXT NOT NULL,
  canonical_source_path TEXT,
  display_name TEXT NOT NULL,
  provenance JSONB NOT NULL,
  UNIQUE (provider_id, canonical_source_path)
);
CREATE TABLE IF NOT EXISTS games (
  id BIGSERIAL PRIMARY KEY,
  provider_id TEXT NOT NULL,
  canonical_box_score_path TEXT NOT NULL,
  game_status TEXT NOT NULL,
  provenance JSONB NOT NULL,
  UNIQUE (provider_id, canonical_box_score_path)
);
CREATE TABLE IF NOT EXISTS game_teams (
  id BIGSERIAL PRIMARY KEY,
  game_id BIGINT NOT NULL REFERENCES games(id),
  side TEXT NOT NULL CHECK (side IN ('home','away','neutral')),
  team_source_path TEXT,
  team_name TEXT NOT NULL,
  final_score INTEGER,
  provenance JSONB NOT NULL,
  UNIQUE (game_id, side, team_source_path)
);
CREATE TABLE IF NOT EXISTS team_game_stats (
  id BIGSERIAL PRIMARY KEY,
  game_team_id BIGINT NOT NULL REFERENCES game_teams(id),
  stat_name TEXT NOT NULL,
  value JSONB NOT NULL,
  provenance JSONB NOT NULL,
  UNIQUE (game_team_id, stat_name)
);
CREATE TABLE IF NOT EXISTS player_game_basic_stats (
  id BIGSERIAL PRIMARY KEY,
  game_id BIGINT NOT NULL REFERENCES games(id),
  player_id BIGINT REFERENCES players(id),
  player_name TEXT NOT NULL,
  stats JSONB NOT NULL,
  provenance JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS player_game_advanced_stats (
  id BIGSERIAL PRIMARY KEY,
  game_id BIGINT NOT NULL REFERENCES games(id),
  player_id BIGINT REFERENCES players(id),
  player_name TEXT NOT NULL,
  stats JSONB NOT NULL,
  provenance JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS game_observations (
  id BIGSERIAL PRIMARY KEY,
  provider_id TEXT NOT NULL,
  canonical_box_score_path TEXT NOT NULL,
  parent_job_id BIGINT REFERENCES crawl_jobs(id),
  source_fetch_id BIGINT REFERENCES source_fetches(id),
  observation JSONB NOT NULL,
  UNIQUE (provider_id, canonical_box_score_path, parent_job_id)
);
CREATE TABLE IF NOT EXISTS unavailable_coverage (
  id BIGSERIAL PRIMARY KEY,
  provider_id TEXT NOT NULL,
  school_source_path TEXT NOT NULL,
  ending_year INTEGER NOT NULL,
  reason TEXT NOT NULL,
  provenance JSONB,
  UNIQUE (provider_id, school_source_path, ending_year)
);
CREATE TABLE IF NOT EXISTS reconciliation_issues (
  id BIGSERIAL PRIMARY KEY,
  issue_type TEXT NOT NULL,
  record_key TEXT NOT NULL,
  details JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','accepted'))
);
CREATE TABLE IF NOT EXISTS raw_object_repair (
  checksum TEXT PRIMARY KEY,
  object_path TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','orphan','repaired','retained','deleted')),
  observed_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS in_flight_requests (
  request_id TEXT PRIMARY KEY,
  job_id BIGINT NOT NULL REFERENCES crawl_jobs(id),
  provider_id TEXT NOT NULL,
  host TEXT NOT NULL,
  lease_generation BIGINT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  released_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_request_per_host ON in_flight_requests(host) WHERE released_at IS NULL;
CREATE TABLE IF NOT EXISTS operator_dispositions (
  id BIGSERIAL PRIMARY KEY,
  job_id BIGINT NOT NULL REFERENCES crawl_jobs(id),
  disposition TEXT NOT NULL CHECK (disposition IN ('hold','release_retry','release_permanent')),
  operator_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS authorization_records (
  id BIGSERIAL PRIMARY KEY,
  provider_id TEXT NOT NULL,
  status TEXT NOT NULL,
  uses JSONB NOT NULL,
  evidence_ref TEXT NOT NULL,
  expires_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS publication_policies (
  id BIGSERIAL PRIMARY KEY,
  provider_id TEXT NOT NULL,
  data_contract_version TEXT NOT NULL,
  attribution TEXT NOT NULL,
  source_links_required BOOLEAN NOT NULL,
  redistribution TEXT NOT NULL,
  retention TEXT NOT NULL
);

COMMIT;
