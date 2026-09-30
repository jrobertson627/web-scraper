BEGIN;

-- The interface march-madness-tracker reads (#119, #132). The tracker reads this
-- database directly, so its contract is not the tables, which migrations may
-- change, but these views. Everything here is versioned: the schema is
-- `tracker_v1`, its columns are frozen (fixtures/tracker/tracker_v1.json holds
-- them and CI compares), and a change that would alter a view's shape is a new
-- version, a second schema next to this one, so the tracker moves when it is ready
-- and a migration can never break it silently. Only 018 may mention tracker_v1.
--
-- What the views expose is limited to the retained fields of the data contract
-- (config/personal-use.data-contract.json): the domain rows, keyed by the
-- provider's own paths, never the crawl's internals (fetches, raw objects,
-- parse runs, provenance, authorization, halts). The one exception is
-- season_completeness, which reads job states, and only as counts.
--
-- Stat columns are NULL when the source value is not present; value_states says
-- why (blank, unavailable, null) for those that are not. Percentages are
-- fractions, minutes are decimal minutes. The role that reads these views is
-- given the schema and nothing else (npm run grant:tracker).

CREATE SCHEMA IF NOT EXISTS tracker_v1;

CREATE OR REPLACE VIEW tracker_v1.schools AS
SELECT s.canonical_source_path AS school_path, s.display_name, s.city, s.state, s.from_year, s.to_year, s.eligible,
  s.source_url, s.aggregate_fields
FROM public.schools s;

CREATE OR REPLACE VIEW tracker_v1.seasons AS
SELECT s.canonical_source_path AS school_path, ss.ending_year, ss.coverage_status,
  t.wins, t.losses, t.conf_wins, t.conf_losses, t.srs, t.sos, t.off_rtg, t.def_rtg,
  t.conference_name, t.conference_path, t.coach_name, t.coach_path, t.ncaa_seed, t.ncaa_region, t.ncaa_games
FROM public.school_seasons ss
JOIN public.schools s ON s.id = ss.school_id
LEFT JOIN public.team_seasons t ON t.school_season_id = ss.id;

CREATE OR REPLACE VIEW tracker_v1.season_team_stats AS
SELECT s.canonical_source_path AS school_path, ss.ending_year, st.side, st.games,
  st.minutes, st.fg, st.fga, st.fg3, st.fg3a, st.ft, st.fta, st.orb, st.drb, st.trb, st.ast, st.stl, st.blk, st.tov, st.pf, st.pts,
  st.value_states
FROM public.team_season_stats st
JOIN public.school_seasons ss ON ss.id = st.school_season_id
JOIN public.schools s ON s.id = ss.school_id;

CREATE OR REPLACE VIEW tracker_v1.season_rosters AS
SELECT s.canonical_source_path AS school_path, ss.ending_year, r.source_row_index, r.player_source_path AS player_path, r.player_name,
  r.jersey_number, r.class, r.position, r.height_in, r.weight, r.value_states
FROM public.season_rosters r
JOIN public.school_seasons ss ON ss.id = r.school_season_id
JOIN public.schools s ON s.id = ss.school_id;

CREATE OR REPLACE VIEW tracker_v1.season_player_stats AS
SELECT s.canonical_source_path AS school_path, ss.ending_year, ps.source_row_index, p.canonical_source_path AS player_path, ps.player_name,
  ps.games, ps.games_started,
  ps.minutes, ps.fg, ps.fga, ps.fg3, ps.fg3a, ps.ft, ps.fta, ps.orb, ps.drb, ps.trb, ps.ast, ps.stl, ps.blk, ps.tov, ps.pf, ps.pts,
  ps.advanced, ps.value_states
FROM public.player_season_stats ps
JOIN public.school_seasons ss ON ss.id = ps.school_season_id
JOIN public.schools s ON s.id = ss.school_id
LEFT JOIN public.players p ON p.id = ps.player_id;

CREATE OR REPLACE VIEW tracker_v1.game_log_rows AS
SELECT s.canonical_source_path AS school_path, ss.ending_year, g.source_row_index, g.game_number, g.game_date, g.location,
  g.opponent_name, g.opponent_school_path, g.game_type, g.result, g.game_status, g.overtimes, g.team_score, g.opponent_score,
  g.canonical_box_score_path AS game_path
FROM public.game_log_rows g
JOIN public.school_seasons ss ON ss.id = g.school_season_id
JOIN public.schools s ON s.id = ss.school_id;

CREATE OR REPLACE VIEW tracker_v1.game_log_row_stats AS
SELECT s.canonical_source_path AS school_path, ss.ending_year, g.source_row_index, gs.side,
  gs.minutes, gs.fg, gs.fga, gs.fg3, gs.fg3a, gs.ft, gs.fta, gs.orb, gs.drb, gs.trb, gs.ast, gs.stl, gs.blk, gs.tov, gs.pf, gs.pts,
  gs.value_states
FROM public.game_log_row_stats gs
JOIN public.game_log_rows g ON g.id = gs.game_log_row_id
JOIN public.school_seasons ss ON ss.id = g.school_season_id
JOIN public.schools s ON s.id = ss.school_id;

CREATE OR REPLACE VIEW tracker_v1.games AS
SELECT g.canonical_box_score_path AS game_path, g.source_url, g.game_date, g.game_status, g.game_type, g.neutral_site,
  g.venue, g.attendance, g.overtimes, g.description, g.line_scores
FROM public.games g;

CREATE OR REPLACE VIEW tracker_v1.game_teams AS
SELECT g.canonical_box_score_path AS game_path, gt.side, gt.team_source_path AS team_path, gt.team_name, gt.final_score, gt.line_score
FROM public.game_teams gt
JOIN public.games g ON g.id = gt.game_id;

CREATE OR REPLACE VIEW tracker_v1.team_game_stats AS
SELECT g.canonical_box_score_path AS game_path, gt.side,
  tg.minutes, tg.fg, tg.fga, tg.fg3, tg.fg3a, tg.ft, tg.fta, tg.orb, tg.drb, tg.trb, tg.ast, tg.stl, tg.blk, tg.tov, tg.pf, tg.pts,
  tg.advanced, tg.value_states
FROM public.team_game_stats tg
JOIN public.game_teams gt ON gt.id = tg.game_team_id
JOIN public.games g ON g.id = gt.game_id;

CREATE OR REPLACE VIEW tracker_v1.player_game_stats AS
SELECT g.canonical_box_score_path AS game_path, gt.side, pg.source_row_index, p.canonical_source_path AS player_path, pg.player_name, pg.starter,
  pg.minutes, pg.fg, pg.fga, pg.fg3, pg.fg3a, pg.ft, pg.fta, pg.orb, pg.drb, pg.trb, pg.ast, pg.stl, pg.blk, pg.tov, pg.pf, pg.pts,
  pg.advanced, pg.value_states
FROM public.player_game_stats pg
JOIN public.game_teams gt ON gt.id = pg.game_team_id
JOIN public.games g ON g.id = gt.game_id
LEFT JOIN public.players p ON p.id = pg.player_id;

-- What the store was crawled under: a sample is not complete coverage, so read this
-- before treating the data as whole. One row; none for a store that has never run.
CREATE OR REPLACE VIEW tracker_v1.crawl_scope AS
SELECT c.kind, c.schools, c.ending_years, c.recorded_at
FROM public.crawl_scopes c
ORDER BY c.id DESC
LIMIT 1;

-- Whether a season's pages have all settled (#132). The crawl goes level by level:
-- every school history, then every season, then every game log, then all the box
-- scores. For about two days a reader sees seasons and game logs with no box scores,
-- and could not tell a partial season from a finished one. state is:
--   unavailable  the site has no such season for the school; nothing will arrive
--   in_progress  the season page or game log is not parsed yet, or a linked box
--                score is still waiting (not yet fetched, waiting to retry, or
--                stopped for an operator)
--   complete     the season and its game log are parsed and every linked box score
--                is parsed or has failed for good (box_scores_failed says how many)
-- A season whose page publishes no game-log link stays in_progress in v1.
CREATE OR REPLACE VIEW tracker_v1.season_completeness AS
WITH link_states AS (
  SELECT r.school_season_id, j.state
  FROM public.game_log_rows r
  LEFT JOIN public.crawl_jobs j
    ON j.provider_id = r.provider_id AND j.canonical_path = r.canonical_box_score_path AND j.page_type = 'box_score'
  WHERE r.canonical_box_score_path IS NOT NULL
), per_season AS (
  SELECT school_season_id,
    count(*) AS box_scores_linked,
    count(*) FILTER (WHERE state = 'parsed') AS box_scores_parsed,
    count(*) FILTER (WHERE state IN ('parse_failed', 'permanently_failed')) AS box_scores_failed
  FROM link_states
  GROUP BY school_season_id
), logged AS (
  SELECT DISTINCT school_season_id FROM public.game_log_rows
)
SELECT s.canonical_source_path AS school_path, ss.ending_year,
  (t.id IS NOT NULL) AS season_parsed,
  (lg.school_season_id IS NOT NULL) AS game_log_parsed,
  COALESCE(p.box_scores_linked, 0) AS box_scores_linked,
  COALESCE(p.box_scores_parsed, 0) AS box_scores_parsed,
  COALESCE(p.box_scores_failed, 0) AS box_scores_failed,
  COALESCE(p.box_scores_linked - p.box_scores_parsed - p.box_scores_failed, 0) AS box_scores_pending,
  CASE
    WHEN ss.coverage_status = 'unavailable' THEN 'unavailable'
    WHEN t.id IS NULL OR lg.school_season_id IS NULL THEN 'in_progress'
    WHEN COALESCE(p.box_scores_linked - p.box_scores_parsed - p.box_scores_failed, 0) > 0 THEN 'in_progress'
    ELSE 'complete'
  END AS state
FROM public.school_seasons ss
JOIN public.schools s ON s.id = ss.school_id
LEFT JOIN public.team_seasons t ON t.school_season_id = ss.id
LEFT JOIN logged lg ON lg.school_season_id = ss.id
LEFT JOIN per_season p ON p.school_season_id = ss.id;

INSERT INTO schema_migrations(version) VALUES ('018_tracker_v1') ON CONFLICT (version) DO NOTHING;
COMMIT;
