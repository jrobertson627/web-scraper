# The tracker interface

march-madness-tracker reads this database directly (`DEPLOYMENT.md`). What it reads is a set of **versioned views**, not the tables: migrations may change the tables, and the tracker must not break when they do (#119, #132). The views live in the schema `tracker_v1`; a change that would alter any of their columns is a new schema, `tracker_v2`, next to it, and the tracker moves when it is ready.

## Rules

- **The role reads the views and nothing else.** `npm run grant:tracker` gives the tracker's login role `USAGE` on the `tracker_v<n>` schemas and `SELECT` on their views, and revokes everything in `public`. The views run with their owner's privileges, so the role needs no table access. It cannot write, and it cannot see fetches, raw objects, parse runs, provenance, authorization records or halts. It should be an ordinary login role (the script refuses a superuser or a role that can create roles or databases).
- **A version is frozen.** `fixtures/tracker/tracker_v1.json` lists every view's columns (name and type, in order). The PostgreSQL CI job compares the live schema to it, and a static test allows only migration `018_tracker_v1.sql` to mention `tracker_v1`. Adding a column, removing one, renaming one or changing a type therefore fails CI until the change is made as a new version with its own snapshot. Adding a whole new view to an existing version is also a shape change and is not done: it goes in the next version.
- **Retiring a version** is a decision, not a side effect: drop `tracker_v1` in a migration only after the tracker has moved, and remove its snapshot in the same change.
- **Only retained fields.** The views expose the fields the data contract retains (`config/personal-use.data-contract.json`), which the normalizer already limits what is stored to. The publication decision is recorded in `AUTHORIZATION_CONTRACT.md`.
- **Keys are the provider's own paths**, never database ids: `school_path` (for example `www.sports-reference.com/cbb/schools/duke/men`), `ending_year`, `game_path` (the box score's path), `player_path` and `team_path` (which may be null when the source publishes no link).

## Views in `tracker_v1`

| View | One row per | Notes |
| --- | --- | --- |
| `schools` | school | name, city, state, first and last season, whether it is eligible, source URL, aggregate fields |
| `seasons` | school and ending year | `coverage_status` (`linked` or `unavailable`), record, conference, coach, SRS, SOS, ratings, NCAA seed, region and games |
| `season_team_stats` | season and side (`team` or `opponent`) | the sixteen counting stats |
| `season_rosters` | roster row | name, jersey number, class, position, height, weight |
| `season_player_stats` | season player row | games, games started, the counting stats, `advanced` |
| `game_log_rows` | game log row | date, location, opponent, result, status, overtimes, scores, `game_path` to the box score when there is one; `source_row_index` keys it |
| `game_log_row_stats` | game log row and side | the team totals the log carries |
| `games` | box score | date, status, type, neutral site, venue, attendance, overtimes, description, line scores |
| `game_teams` | game and side (`home` or `away`) | team, final score, line score |
| `team_game_stats` | game and side | the counting stats and `advanced` |
| `player_game_stats` | player line | starter, the counting stats and `advanced` |
| `crawl_scope` | (one row) | what the store was crawled under: `kind` `sample` or `full`, the schools and years. **Read it before treating the data as whole** |
| `season_completeness` | school and ending year | see below |

Stat columns are `NULL` when the source value is not present, and `value_states` (JSON) says why for the ones that are not: `blank`, `unavailable` or `null`. Percentages are fractions and minutes are decimal minutes. A join between views is on the path columns, for example `game_log_rows.game_path = games.game_path`.

## Complete and partial seasons

The crawl runs level by level: every school history, then every season, then every game log, then all the box scores, which takes about two days for the backfill. During that time a reader sees seasons and game logs with no box scores. `season_completeness` says which seasons are done:

| `state` | Meaning |
| --- | --- |
| `unavailable` | the site has no such season for the school; nothing will arrive |
| `in_progress` | the season page or game log is not parsed yet, or a linked box score is still waiting: not fetched yet, waiting to retry, or stopped for an operator |
| `complete` | the season and its game log are parsed and every linked box score is parsed or has failed for good |

The counts behind it are `box_scores_linked`, `box_scores_parsed`, `box_scores_failed` and `box_scores_pending`. To list only seasons whose pages have all settled: `WHERE state = 'complete'`. A season with `box_scores_failed > 0` is settled but has games without a box score; decide whether that is good enough for the use. **v1 limit:** a season whose page publishes no game-log link stays `in_progress`.

## Changing an interface

1. Add `migrations/0NN_tracker_v2.sql` creating the `tracker_v2` schema and its views (all of them, not only the changed ones, so the tracker moves once).
2. Add `fixtures/tracker/tracker_v2.json` (copy the columns the PostgreSQL job prints when the snapshot test fails), extend the view list in `test/tracker-views.test.mjs`, and run `npm run grant:tracker` so the role can read it.
3. Keep `tracker_v1` until the tracker has moved.
