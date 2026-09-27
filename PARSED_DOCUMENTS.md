# Parsed document contracts

Each page type has one frozen document shape, checked by `assertParsedDocument(pageType, document)` in `src/contracts/parsed-documents.mjs`. `ParserRegistry.parse` runs the check on every valid parse result. A document that breaks its contract becomes a `structural_failure` naming the first bad field (for example `season.endingYear: expected an integer >= 1800`), so the page is quarantined like a layout change. Unknown fields are rejected; source-specific or derivable values go in an `extra` object.

## Value rules

- **Statistics are source values**: `blank`, `unavailable(reason)`, explicit `null`, or `present(value)` (`src/contracts/value-state.mjs`). `present(0)` is a real zero. A blank cell is `blank`, never zero.
- **Descriptive text and links** (names, paths, dates, locations) are plain strings or `null` when the source does not show them.
- **Percentages are fractions**: 33% is `0.33`. A printed `.333` stays `0.333`.
- **Minutes are decimal minutes**: `32:30` is `32.5`. Use `decimalMinutes(clock)`.
- **Links** are strings resolved against the page URL. A link to another school carries the school's page path (`schoolPath`), which is its identity. Schools are never matched by display name. `schoolPath` is `null` when the source does not link the team.
- **Rows** are listed in source order. Array position is the source row index. Parsers drop repeated header rows and rank rows; they keep incomplete data rows.

## Stat line

The sixteen core counting stats, each a source value:

`minutes`, `fg`, `fga`, `fg3`, `fg3a`, `ft`, `fta`, `orb`, `drb`, `trb`, `ast`, `stl`, `blk`, `tov`, `pf`, `pts`

`minutes` is decimal; every other field is a whole number. Optional `extra` holds printed percentages and other derivable figures (`fg2`, `fg2a`, `efg_pct`, `game_score`) as source values. Storage uses named columns for the core stats and JSON for `extra`.

## Page types

| Page type | Document |
|---|---|
| `school_index` | `schools[]`: `name`, `path` (school page, its identity), `historyUrl`, `city`, `state`, `from`, `to`; optional `aliases[]`, `aggregateFields{}` |
| `school_history` | `seasons[]`: `endingYear`, `url` (`null` when the season is not linked); optional `extra{}` |
| `season` | `school`, `endingYear`, `gameLogUrl`, `summary`, `roster[]`, `teamTotals`, `players[]` |
| `game_log` | `endingYear`, `games[]` |
| `box_score` | `date`, `status`, `gameType`, `description`, `venue`, `attendance`, `overtimes`, `teams[]`; optional `context` |

**`season.summary`**: `wins`, `losses`, `confWins`, `confLosses`, `srs`, `sos`, `offRtg`, `defRtg` (source values); `conference` and `coach` (`{ name, path }` or `null`); `ncaaTournament` (`null`, or `{ seed, region, games[] }`, where each game has `round`, `result` (`W`/`L`), `teamScore`, `opponentScore`, `opponent: { name, seed }`). Pace is not printed on the season page, so it is not part of the document.

**`season.roster[]`**: `name`, `playerPath`, `number`, `class`, `position`, `heightIn`, `weight`; optional `extra` (hometown, high school, recruiting rank).

**`season.teamTotals`**: `{ team, opponent }`, each `{ games, stats }` with a stat line of season totals; `null` when the page has no totals table.

**`season.players[]`**: `name`, `playerPath`, `games`, `gamesStarted`, `stats` (season totals stat line), `advanced{}` (PER, WS, BPM and similar).

**`game_log.games[]`**: `gameNumber`, `date`, `location` (`home`/`away`/`neutral`/`null`), `opponent: { name, schoolPath }`, `gameType`, `result` (`W`/`L`/`null`), `status`, `overtimes`, `teamScore`, `opponentScore`, `teamStats`, `opponentStats` (stat lines, or `null` when the row has no stat cells), `boxScoreUrl`.

**`box_score.teams[]`**: exactly one `away` and one `home` entry, each with `side`, `name`, `schoolPath`, `finalScore`, `lineScore[]` (points per period), `stats` (team totals stat line or `null`), `advanced{}`, and `players[]` (`name`, `playerPath`, `starter`, `stats`, `advanced{}`).

`status` is one of `scheduled`, `final`, `canceled`, `rescheduled`, `incomplete`. A box score sets `context` only when the page states it. Sports Reference box scores do not, so neutral-site context comes from the `location` of the game-log rows that link the box score.

## Sports Reference notes

From the captured pages (`fixtures/sports-reference/README.md`):

- Opponent links point to the opponent's season page (`/cbb/schools/<slug>/men/2024.html`). The parser derives `schoolPath` (`/cbb/schools/<slug>/men/`) from it.
- Box-score `line-score`, `four-factors` and `game-info`, and season `players_advanced`, sit inside HTML comments.
- Season tables used: the `#info` summary, `roster`, `season-total_totals`, `players_totals` and `players_advanced`. The per-game, per-40 and per-100-possession tables and the conference-only `_conf` tables are not parsed; they are derivable, and raw pages are retained for reprocessing.
- The season summary carries the NCAA seed, region and round results.

## Reconciliation

The fixture reconciliation report (`src/application/reconciliation.mjs`) checks these documents against each other:

- `game_log_result_matches_scores`: a final row's result agrees with its scores.
- `box_score_game_log_totals`: each game-log row matches its box score's status, both final scores, and both stat lines.
- `season_record_matches_game_logs`: season wins and losses equal the game-log results.
- `season_totals_match_game_logs`: season team and opponent totals equal the sum of final game-log rows.
- `season_totals_match_box_scores`: the same totals equal the sum of the linked box scores, once all are parsed.
- `player_season_totals_match_box_scores`: each linked player's season totals equal their box-score lines for that school, once all are parsed.

Minutes are compared within one minute, to allow for rounding between season and per-game figures.
