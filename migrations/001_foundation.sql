BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS crawl_jobs (
  id BIGSERIAL PRIMARY KEY,
  provider_id TEXT NOT NULL,
  canonical_path TEXT NOT NULL,
  page_type TEXT NOT NULL CHECK (page_type IN ('school_index','school_history','season','game_log','box_score')),
  source_url TEXT NOT NULL,
  parent_job_id BIGINT REFERENCES crawl_jobs(id),
  school_source_path TEXT,
  parser_version TEXT NOT NULL DEFAULT '1',
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','fetching','fetched','parsed','retry_wait','permanently_failed','parse_failed','operator_stop')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_allowed_at TIMESTAMPTZ,
  last_error TEXT,
  claim_owner TEXT,
  claim_expires_at TIMESTAMPTZ,
  lease_generation BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider_id, canonical_path, page_type),
  CHECK ((state = 'fetching') = (claim_owner IS NOT NULL AND claim_expires_at IS NOT NULL AND lease_generation IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS crawl_jobs_claim_idx ON crawl_jobs (state, next_allowed_at, created_at);

CREATE TABLE IF NOT EXISTS source_fetches (
  id BIGSERIAL PRIMARY KEY,
  job_id BIGINT NOT NULL REFERENCES crawl_jobs(id),
  provider_id TEXT NOT NULL,
  canonical_path TEXT NOT NULL,
  http_status INTEGER NOT NULL CHECK (http_status BETWEEN 100 AND 599),
  fetched_at TIMESTAMPTZ NOT NULL,
  etag TEXT,
  last_modified TEXT,
  checksum TEXT,
  raw_object_path TEXT,
  reused_body BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS source_fetches_job_idx ON source_fetches (job_id, fetched_at DESC);

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
CREATE INDEX IF NOT EXISTS parse_runs_job_idx ON parse_runs (job_id, parsed_at DESC);

CREATE TABLE IF NOT EXISTS schools (
  id BIGSERIAL PRIMARY KEY,
  provider_id TEXT NOT NULL,
  canonical_source_path TEXT NOT NULL,
  source_url TEXT NOT NULL,
  display_name TEXT NOT NULL,
  city TEXT,
  state TEXT,
  from_year INTEGER,
  to_year INTEGER,
  aggregate_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
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
CREATE INDEX IF NOT EXISTS school_aliases_school_idx ON school_aliases (school_id);

CREATE TABLE IF NOT EXISTS school_seasons (
  id BIGSERIAL PRIMARY KEY,
  school_id BIGINT NOT NULL REFERENCES schools(id),
  ending_year INTEGER NOT NULL CHECK (ending_year BETWEEN 1900 AND 2200),
  coverage_status TEXT NOT NULL CHECK (coverage_status IN ('linked','unavailable')),
  provenance JSONB,
  UNIQUE (school_id, ending_year)
);
CREATE INDEX IF NOT EXISTS school_seasons_school_idx ON school_seasons (school_id);

CREATE TABLE IF NOT EXISTS season_rosters (
  id BIGSERIAL PRIMARY KEY,
  school_season_id BIGINT NOT NULL REFERENCES school_seasons(id),
  player_source_path TEXT,
  player_name TEXT NOT NULL,
  provenance JSONB NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS season_rosters_identity_idx ON season_rosters (school_season_id, COALESCE(player_source_path, ''), player_name);

CREATE TABLE IF NOT EXISTS players (
  id BIGSERIAL PRIMARY KEY,
  provider_id TEXT NOT NULL,
  canonical_source_path TEXT,
  display_name TEXT NOT NULL,
  provenance JSONB NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS players_identity_idx ON players (provider_id, COALESCE(canonical_source_path, ''), display_name);

CREATE TABLE IF NOT EXISTS games (
  id BIGSERIAL PRIMARY KEY,
  provider_id TEXT NOT NULL,
  canonical_box_score_path TEXT NOT NULL,
  source_url TEXT NOT NULL,
  game_date DATE,
  game_status TEXT NOT NULL CHECK (game_status IN ('scheduled','final','canceled','rescheduled','incomplete')),
  game_type TEXT,
  neutral_site BOOLEAN,
  overtime TEXT,
  line_scores JSONB NOT NULL DEFAULT '{}'::jsonb,
  provenance JSONB NOT NULL,
  UNIQUE (provider_id, canonical_box_score_path)
);
CREATE INDEX IF NOT EXISTS games_date_idx ON games (game_date);

CREATE TABLE IF NOT EXISTS game_teams (
  id BIGSERIAL PRIMARY KEY,
  game_id BIGINT NOT NULL REFERENCES games(id),
  side TEXT NOT NULL CHECK (side IN ('home','away')),
  team_source_path TEXT,
  team_name TEXT NOT NULL,
  final_score INTEGER,
  provenance JSONB NOT NULL,
  UNIQUE (game_id, side)
);
CREATE INDEX IF NOT EXISTS game_teams_game_idx ON game_teams (game_id);

CREATE TABLE IF NOT EXISTS team_game_stats (
  id BIGSERIAL PRIMARY KEY,
  game_team_id BIGINT NOT NULL REFERENCES game_teams(id),
  stat_name TEXT NOT NULL,
  value JSONB NOT NULL,
  provenance JSONB NOT NULL,
  UNIQUE (game_team_id, stat_name)
);
CREATE INDEX IF NOT EXISTS team_game_stats_team_idx ON team_game_stats (game_team_id);

CREATE TABLE IF NOT EXISTS player_game_basic_stats (
  id BIGSERIAL PRIMARY KEY,
  game_id BIGINT NOT NULL REFERENCES games(id),
  player_id BIGINT REFERENCES players(id),
  player_name TEXT NOT NULL,
  stats JSONB NOT NULL,
  provenance JSONB NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS player_game_basic_identity_idx ON player_game_basic_stats (game_id, COALESCE(player_id, 0), player_name);

CREATE TABLE IF NOT EXISTS player_game_advanced_stats (
  id BIGSERIAL PRIMARY KEY,
  game_id BIGINT NOT NULL REFERENCES games(id),
  player_id BIGINT REFERENCES players(id),
  player_name TEXT NOT NULL,
  stats JSONB NOT NULL,
  provenance JSONB NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS player_game_advanced_identity_idx ON player_game_advanced_stats (game_id, COALESCE(player_id, 0), player_name);

CREATE TABLE IF NOT EXISTS game_observations (
  id BIGSERIAL PRIMARY KEY,
  provider_id TEXT NOT NULL,
  canonical_box_score_path TEXT NOT NULL,
  parent_job_id BIGINT NOT NULL REFERENCES crawl_jobs(id),
  source_fetch_id BIGINT REFERENCES source_fetches(id),
  observation JSONB NOT NULL,
  UNIQUE (provider_id, canonical_box_score_path, parent_job_id)
);
CREATE INDEX IF NOT EXISTS game_observations_game_idx ON game_observations (provider_id, canonical_box_score_path);

CREATE TABLE IF NOT EXISTS unavailable_coverage (
  id BIGSERIAL PRIMARY KEY,
  provider_id TEXT NOT NULL,
  school_source_path TEXT NOT NULL,
  ending_year INTEGER NOT NULL CHECK (ending_year BETWEEN 1900 AND 2200),
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
CREATE INDEX IF NOT EXISTS reconciliation_issues_open_idx ON reconciliation_issues (status, issue_type);

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
CREATE INDEX IF NOT EXISTS authorization_records_provider_idx ON authorization_records (provider_id, status);

CREATE TABLE IF NOT EXISTS publication_policies (
  id BIGSERIAL PRIMARY KEY,
  provider_id TEXT NOT NULL,
  data_contract_version TEXT NOT NULL,
  attribution TEXT NOT NULL,
  source_links_required BOOLEAN NOT NULL,
  redistribution TEXT NOT NULL,
  retention TEXT NOT NULL
);

INSERT INTO schema_migrations (version) VALUES ('001_foundation') ON CONFLICT (version) DO NOTHING;
COMMIT;
