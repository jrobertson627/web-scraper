BEGIN;

-- Normalized storage for the frozen parsed documents (#76; PARSED_DOCUMENTS.md).
-- Every stat-line table stores the sixteen core counting stats as named columns
-- (NULL when the source value is not present), the non-present source-value
-- states in value_states (e.g. {"stl":{"state":"blank"}}), and everything else
-- on the row in JSON. Percentages are fractions; minutes are decimal minutes.

-- Replace the key/value team stats and the JSON player stats. The database holds
-- no real data yet; the checks keep a repeat run from dropping the new tables.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'team_game_stats' AND column_name = 'stat_name') THEN
    DROP TABLE team_game_stats;
  END IF;
END $$;
DROP TABLE IF EXISTS player_game_basic_stats;
DROP TABLE IF EXISTS player_game_advanced_stats;

ALTER TABLE games ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE games ADD COLUMN IF NOT EXISTS venue TEXT;
ALTER TABLE games ADD COLUMN IF NOT EXISTS attendance INTEGER;
ALTER TABLE games ADD COLUMN IF NOT EXISTS overtimes INTEGER;
ALTER TABLE games ADD COLUMN IF NOT EXISTS extra JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE games DROP COLUMN IF EXISTS overtime;
ALTER TABLE game_teams ADD COLUMN IF NOT EXISTS line_score JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS team_game_stats (
  id BIGSERIAL PRIMARY KEY,
  game_team_id BIGINT NOT NULL UNIQUE REFERENCES game_teams(id),
  minutes NUMERIC, fg INTEGER, fga INTEGER, fg3 INTEGER, fg3a INTEGER, ft INTEGER, fta INTEGER,
  orb INTEGER, drb INTEGER, trb INTEGER, ast INTEGER, stl INTEGER, blk INTEGER, tov INTEGER, pf INTEGER, pts INTEGER,
  advanced JSONB NOT NULL DEFAULT '{}'::jsonb,
  extra JSONB NOT NULL DEFAULT '{}'::jsonb,
  value_states JSONB NOT NULL DEFAULT '{}'::jsonb,
  provenance JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS player_game_stats (
  id BIGSERIAL PRIMARY KEY,
  game_team_id BIGINT NOT NULL REFERENCES game_teams(id),
  source_row_index INTEGER NOT NULL CHECK (source_row_index >= 0),
  player_id BIGINT REFERENCES players(id),
  player_name TEXT NOT NULL,
  starter BOOLEAN,
  minutes NUMERIC, fg INTEGER, fga INTEGER, fg3 INTEGER, fg3a INTEGER, ft INTEGER, fta INTEGER,
  orb INTEGER, drb INTEGER, trb INTEGER, ast INTEGER, stl INTEGER, blk INTEGER, tov INTEGER, pf INTEGER, pts INTEGER,
  advanced JSONB NOT NULL DEFAULT '{}'::jsonb,
  extra JSONB NOT NULL DEFAULT '{}'::jsonb,
  value_states JSONB NOT NULL DEFAULT '{}'::jsonb,
  provenance JSONB NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS player_game_stats_linked_identity_idx ON player_game_stats (game_team_id, player_id) WHERE player_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS player_game_stats_unlinked_row_identity_idx ON player_game_stats (game_team_id, source_row_index) WHERE player_id IS NULL;
CREATE INDEX IF NOT EXISTS player_game_stats_player_idx ON player_game_stats (player_id);

CREATE TABLE IF NOT EXISTS team_seasons (
  id BIGSERIAL PRIMARY KEY,
  school_season_id BIGINT NOT NULL UNIQUE REFERENCES school_seasons(id),
  wins INTEGER, losses INTEGER, conf_wins INTEGER, conf_losses INTEGER,
  srs NUMERIC, sos NUMERIC, off_rtg NUMERIC, def_rtg NUMERIC,
  conference_name TEXT, conference_path TEXT, coach_name TEXT, coach_path TEXT,
  ncaa_seed INTEGER, ncaa_region TEXT,
  ncaa_games JSONB NOT NULL DEFAULT '[]'::jsonb,
  extra JSONB NOT NULL DEFAULT '{}'::jsonb,
  value_states JSONB NOT NULL DEFAULT '{}'::jsonb,
  provenance JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS team_season_stats (
  id BIGSERIAL PRIMARY KEY,
  school_season_id BIGINT NOT NULL REFERENCES school_seasons(id),
  side TEXT NOT NULL CHECK (side IN ('team','opponent')),
  games INTEGER,
  minutes NUMERIC, fg INTEGER, fga INTEGER, fg3 INTEGER, fg3a INTEGER, ft INTEGER, fta INTEGER,
  orb INTEGER, drb INTEGER, trb INTEGER, ast INTEGER, stl INTEGER, blk INTEGER, tov INTEGER, pf INTEGER, pts INTEGER,
  extra JSONB NOT NULL DEFAULT '{}'::jsonb,
  value_states JSONB NOT NULL DEFAULT '{}'::jsonb,
  provenance JSONB NOT NULL,
  UNIQUE (school_season_id, side)
);

CREATE TABLE IF NOT EXISTS player_season_stats (
  id BIGSERIAL PRIMARY KEY,
  school_season_id BIGINT NOT NULL REFERENCES school_seasons(id),
  source_row_index INTEGER NOT NULL CHECK (source_row_index >= 0),
  player_id BIGINT REFERENCES players(id),
  player_name TEXT NOT NULL,
  games INTEGER, games_started INTEGER,
  minutes NUMERIC, fg INTEGER, fga INTEGER, fg3 INTEGER, fg3a INTEGER, ft INTEGER, fta INTEGER,
  orb INTEGER, drb INTEGER, trb INTEGER, ast INTEGER, stl INTEGER, blk INTEGER, tov INTEGER, pf INTEGER, pts INTEGER,
  advanced JSONB NOT NULL DEFAULT '{}'::jsonb,
  extra JSONB NOT NULL DEFAULT '{}'::jsonb,
  value_states JSONB NOT NULL DEFAULT '{}'::jsonb,
  provenance JSONB NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS player_season_stats_linked_identity_idx ON player_season_stats (school_season_id, player_id) WHERE player_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS player_season_stats_unlinked_row_identity_idx ON player_season_stats (school_season_id, source_row_index) WHERE player_id IS NULL;
CREATE INDEX IF NOT EXISTS player_season_stats_player_idx ON player_season_stats (player_id);

ALTER TABLE season_rosters ADD COLUMN IF NOT EXISTS jersey_number TEXT;
ALTER TABLE season_rosters ADD COLUMN IF NOT EXISTS class TEXT;
ALTER TABLE season_rosters ADD COLUMN IF NOT EXISTS position TEXT;
ALTER TABLE season_rosters ADD COLUMN IF NOT EXISTS height_in INTEGER;
ALTER TABLE season_rosters ADD COLUMN IF NOT EXISTS weight INTEGER;
ALTER TABLE season_rosters ADD COLUMN IF NOT EXISTS extra JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE season_rosters ADD COLUMN IF NOT EXISTS value_states JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS game_log_rows (
  id BIGSERIAL PRIMARY KEY,
  provider_id TEXT NOT NULL,
  school_season_id BIGINT NOT NULL REFERENCES school_seasons(id),
  source_row_index INTEGER NOT NULL CHECK (source_row_index >= 0),
  game_number INTEGER,
  game_date DATE,
  location TEXT CHECK (location IN ('home','away','neutral')),
  opponent_name TEXT,
  opponent_school_path TEXT,
  game_type TEXT,
  result TEXT CHECK (result IN ('W','L')),
  game_status TEXT NOT NULL CHECK (game_status IN ('scheduled','final','canceled','rescheduled','incomplete')),
  overtimes INTEGER CHECK (overtimes >= 0),
  team_score INTEGER,
  opponent_score INTEGER,
  canonical_box_score_path TEXT,
  extra JSONB NOT NULL DEFAULT '{}'::jsonb,
  value_states JSONB NOT NULL DEFAULT '{}'::jsonb,
  provenance JSONB NOT NULL,
  UNIQUE (school_season_id, source_row_index)
);
CREATE INDEX IF NOT EXISTS game_log_rows_box_score_idx ON game_log_rows (provider_id, canonical_box_score_path);
CREATE INDEX IF NOT EXISTS game_log_rows_opponent_idx ON game_log_rows (provider_id, opponent_school_path);

CREATE TABLE IF NOT EXISTS game_log_row_stats (
  id BIGSERIAL PRIMARY KEY,
  game_log_row_id BIGINT NOT NULL REFERENCES game_log_rows(id),
  side TEXT NOT NULL CHECK (side IN ('team','opponent')),
  minutes NUMERIC, fg INTEGER, fga INTEGER, fg3 INTEGER, fg3a INTEGER, ft INTEGER, fta INTEGER,
  orb INTEGER, drb INTEGER, trb INTEGER, ast INTEGER, stl INTEGER, blk INTEGER, tov INTEGER, pf INTEGER, pts INTEGER,
  extra JSONB NOT NULL DEFAULT '{}'::jsonb,
  value_states JSONB NOT NULL DEFAULT '{}'::jsonb,
  provenance JSONB NOT NULL,
  UNIQUE (game_log_row_id, side)
);

INSERT INTO schema_migrations(version) VALUES ('008_parsed_document_storage') ON CONFLICT (version) DO NOTHING;
COMMIT;
