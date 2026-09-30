import { CORE_STAT_FIELDS } from '../contracts/parsed-documents.mjs';
import { canonicalPathString, canonicalizeSourceUrl, createSourceUrl } from '../contracts/source.mjs';


function presentValue(value) { return value?.state === 'present' ? value.value : null; }

// Non-present source-value states, so blank, unavailable and null stay distinct
// even though their named columns are all NULL.
function valueStates(values) {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value && value.state !== 'present'));
}

// The sixteen core stats as column values, plus the value states and extra JSON.
function statColumns(line) {
  const core = Object.fromEntries(CORE_STAT_FIELDS.map((field) => [field, line?.[field]]));
  return {
    values: CORE_STAT_FIELDS.map((field) => presentValue(core[field])),
    valueStates: valueStates(core),
    extra: line?.extra ?? {},
  };
}


function canonicalFor(providerId, target, baseUrl) {
  if (!target) return null;
  const sourceUrl = createSourceUrl(providerId, target, baseUrl);
  const canonical = canonicalizeSourceUrl(sourceUrl);
  if (canonical.host !== new URL(baseUrl).host) throw new Error('linked identity must remain on the source host');
  return canonicalPathString(canonical);
}

// A link that fails canonicalization (off-host or malformed) is kept as a name only.
function linkedPath(providerId, target, baseUrl) {
  try { return canonicalFor(providerId, target, baseUrl); } catch { return null; }
}

function unprefix(providerId, value) {
  const prefix = `${providerId}:`;
  if (!value?.startsWith(prefix)) throw new Error('source identity does not match its provider');
  return value.slice(prefix.length);
}

async function schoolId(client, job) {
  if (!job.school_source_path) return null;
  const result = await client.query('SELECT id FROM schools WHERE provider_id = $1 AND canonical_source_path = $2',
    [job.provider_id, unprefix(job.provider_id, job.school_source_path)]);
  return result.rows[0]?.id ?? null;
}

const JSON_COLUMNS = new Set(['aggregate_fields', 'advanced', 'extra', 'value_states', 'provenance', 'line_score', 'ncaa_games']);

// Keeps the last entry for each key, as sequential per-row upserts would, and
// returns the entries sorted by key. Every commit therefore locks shared rows
// (players, a game's team sides) in the same order, so two workers committing
// pages that touch the same rows cannot deadlock on them.
function lastByKey(entries, key) {
  const byKey = new Map();
  for (const entry of entries) byKey.set(String(key(entry)), entry);
  return [...byKey].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)).map(([, entry]) => entry);
}

// Writes many rows in one INSERT ... VALUES (...),(...) ON CONFLICT statement.
// rows are arrays in `columns` order and must not repeat a conflict key.
async function upsertRows(client, { table, columns, rows, conflict, update = [], returning }) {
  if (!rows.length) return [];
  const values = [];
  const tuples = rows.map((row) => `(${row.map((value, index) => {
    values.push(value);
    return `$${values.length}${JSON_COLUMNS.has(columns[index]) ? '::jsonb' : ''}`;
  }).join(',')})`);
  const action = update.length ? `DO UPDATE SET ${update.map((column) => `${column} = EXCLUDED.${column}`).join(',')}` : 'DO NOTHING';
  const result = await client.query(`INSERT INTO ${table} (${columns.join(',')}) VALUES ${tuples.join(',')}
    ON CONFLICT ${conflict} ${action}${returning ? ` RETURNING ${returning}` : ''}`, values);
  return result.rows;
}

// Upserts every linked player named on a page in one statement and returns
// their ids by canonical path. When a path repeats, the last name wins.
async function upsertPlayers(client, job, players, provenance) {
  const linked = players.map((player) => ({ path: linkedPath(job.provider_id, player.playerPath, job.source_url), name: player.name }))
    .filter((player) => player.path);
  const rows = await upsertRows(client, {
    table: 'players', columns: ['provider_id', 'canonical_source_path', 'display_name', 'provenance'],
    rows: lastByKey(linked, (player) => player.path).map(({ path, name }) => [job.provider_id, path, name, JSON.stringify(provenance)]),
    conflict: '(provider_id,canonical_source_path) WHERE canonical_source_path IS NOT NULL',
    update: ['display_name', 'provenance'], returning: 'id,canonical_source_path',
  });
  const ids = new Map(rows.map((row) => [row.canonical_source_path, row.id]));
  return (player) => ids.get(linkedPath(job.provider_id, player.playerPath, job.source_url)) ?? null;
}

async function writeSchoolIndex(client, job, page, provenance) {
  for (const [rowIndex, school] of (page.data.schools ?? []).entries()) {
    let path;
    try { path = canonicalFor(job.provider_id, school.path, job.source_url); } catch { continue; }
    if (!path) continue;
    const eligible = page.observations.find((entry) => entry.kind === 'school' && entry.rowIndex === rowIndex)?.eligible;
    if (typeof eligible !== 'boolean') throw new Error(`school eligibility observation is missing at row ${rowIndex}`);
    const sourceUrl = new URL(school.path, job.source_url).href;
    const result = await client.query(`INSERT INTO schools
      (provider_id,canonical_source_path,source_url,display_name,city,state,from_year,to_year,aggregate_fields,eligible,provenance)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11::jsonb)
      ON CONFLICT (provider_id,canonical_source_path) DO UPDATE SET
      source_url = EXCLUDED.source_url,display_name = EXCLUDED.display_name,city = EXCLUDED.city,
      state = EXCLUDED.state,from_year = EXCLUDED.from_year,to_year = EXCLUDED.to_year,
      aggregate_fields = EXCLUDED.aggregate_fields,eligible = EXCLUDED.eligible,provenance = EXCLUDED.provenance RETURNING id`,
    [job.provider_id, path, sourceUrl, school.name, school.city ?? null, school.state ?? null,
      school.from ?? null, school.to ?? null, JSON.stringify(school.aggregateFields ?? {}), eligible, JSON.stringify(provenance)]);
    for (const alias of school.aliases ?? []) {
      await client.query('INSERT INTO school_aliases (school_id,alias) VALUES ($1,$2) ON CONFLICT DO NOTHING', [result.rows[0].id, alias]);
    }
  }
}

async function writeSchoolHistory(client, job, page, provenance) {
  const id = await schoolId(client, job);
  if (!id) throw new Error('school history has no stored school identity');
  for (const season of page.data.seasons ?? []) {
    if (!season.url || !Number.isInteger(season.endingYear)) continue;
    // A year the history now links is no longer unavailable (#154).
    await client.query('DELETE FROM unavailable_coverage WHERE provider_id = $1 AND school_source_path = $2 AND ending_year = $3',
      [job.provider_id, unprefix(job.provider_id, job.school_source_path), season.endingYear]);
    await client.query(`INSERT INTO school_seasons (school_id,ending_year,coverage_status,provenance)
      VALUES ($1,$2,'linked',$3::jsonb) ON CONFLICT (school_id,ending_year)
      DO UPDATE SET coverage_status = 'linked',provenance = EXCLUDED.provenance`,
    [id, season.endingYear, JSON.stringify(provenance)]);
  }
}

async function upsertSchoolSeason(client, job, endingYear, provenance) {
  const id = await schoolId(client, job);
  if (!id) return null;
  const season = await client.query(`INSERT INTO school_seasons (school_id,ending_year,coverage_status,provenance)
    VALUES ($1,$2,'linked',$3::jsonb) ON CONFLICT (school_id,ending_year)
    DO UPDATE SET coverage_status = 'linked',provenance = EXCLUDED.provenance RETURNING id`,
  [id, endingYear, JSON.stringify(provenance)]);
  return season.rows[0].id;
}

// Upserts player stat rows keyed by player link when there is one, else by
// source row: one statement for linked rows and one for unlinked rows.
// entries: [{ ownerId, rowIndex, playerId, values }]
async function upsertPlayerRows(client, { table, owner, columns, entries }) {
  const names = [owner, 'source_row_index', 'player_id', ...columns];
  const update = ['source_row_index', ...columns];
  const row = (entry) => [entry.ownerId, entry.rowIndex, entry.playerId, ...entry.values];
  await upsertRows(client, { table, columns: names, update, conflict: `(${owner},player_id) WHERE player_id IS NOT NULL`,
    rows: lastByKey(entries.filter((entry) => entry.playerId), (entry) => `${entry.ownerId}:${entry.playerId}`).map(row) });
  await upsertRows(client, { table, columns: names, update, conflict: `(${owner},source_row_index) WHERE player_id IS NULL`,
    rows: lastByKey(entries.filter((entry) => !entry.playerId), (entry) => `${entry.ownerId}:${entry.rowIndex}`).map(row) });
}

// A superseding revision (a parser change over the same raw body) replaces a
// record's row sets instead of upserting over them, so rows the new parser no
// longer emits are removed. Identity-keyed rows (schools, school seasons,
// players, team_seasons, games) are upserted either way.
async function writeSeason(client, job, page, provenance, { replace = false } = {}) {
  const data = page.data;
  const seasonId = await upsertSchoolSeason(client, job, data.endingYear, provenance);
  if (!seasonId) throw new Error('season has no stored school identity');
  if (replace) {
    for (const table of ['season_rosters', 'player_season_stats', 'team_season_stats']) {
      await client.query(`DELETE FROM ${table} WHERE school_season_id = $1`, [seasonId]);
    }
  }
  const summary = data.summary;
  const tournament = summary.ncaaTournament;
  const summaryValues = {
    wins: summary.wins, losses: summary.losses, confWins: summary.confWins, confLosses: summary.confLosses,
    srs: summary.srs, sos: summary.sos, offRtg: summary.offRtg, defRtg: summary.defRtg,
    ...(tournament ? { ncaaSeed: tournament.seed } : {}),
  };
  await client.query(`INSERT INTO team_seasons
    (school_season_id,wins,losses,conf_wins,conf_losses,srs,sos,off_rtg,def_rtg,conference_name,conference_path,
     coach_name,coach_path,ncaa_seed,ncaa_region,ncaa_games,extra,value_states,provenance)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17::jsonb,$18::jsonb,$19::jsonb)
    ON CONFLICT (school_season_id) DO UPDATE SET wins = EXCLUDED.wins,losses = EXCLUDED.losses,
    conf_wins = EXCLUDED.conf_wins,conf_losses = EXCLUDED.conf_losses,srs = EXCLUDED.srs,sos = EXCLUDED.sos,
    off_rtg = EXCLUDED.off_rtg,def_rtg = EXCLUDED.def_rtg,conference_name = EXCLUDED.conference_name,
    conference_path = EXCLUDED.conference_path,coach_name = EXCLUDED.coach_name,coach_path = EXCLUDED.coach_path,
    ncaa_seed = EXCLUDED.ncaa_seed,ncaa_region = EXCLUDED.ncaa_region,ncaa_games = EXCLUDED.ncaa_games,
    extra = EXCLUDED.extra,value_states = EXCLUDED.value_states,provenance = EXCLUDED.provenance`,
  [seasonId, ...['wins', 'losses', 'confWins', 'confLosses', 'srs', 'sos', 'offRtg', 'defRtg'].map((field) => presentValue(summary[field])),
    summary.conference?.name ?? null, linkedPath(job.provider_id, summary.conference?.path, job.source_url),
    summary.coach?.name ?? null, linkedPath(job.provider_id, summary.coach?.path, job.source_url),
    presentValue(tournament?.seed), tournament?.region ?? null, JSON.stringify(tournament?.games ?? []),
    JSON.stringify(summary.extra ?? {}), JSON.stringify(valueStates(summaryValues)), JSON.stringify(provenance)]);

  const playerId = await upsertPlayers(client, job, [...data.roster, ...data.players], provenance);

  const roster = data.roster.map((player, index) => {
    const path = linkedPath(job.provider_id, player.playerPath, job.source_url);
    return { path, row: [seasonId, index, path, player.name, player.number, player.class, player.position,
      presentValue(player.heightIn), presentValue(player.weight), JSON.stringify(player.extra ?? {}),
      JSON.stringify(valueStates({ heightIn: player.heightIn, weight: player.weight })), JSON.stringify(provenance)] };
  });
  const rosterTable = { table: 'season_rosters', columns: ['school_season_id', 'source_row_index', 'player_source_path', 'player_name',
    'jersey_number', 'class', 'position', 'height_in', 'weight', 'extra', 'value_states', 'provenance'],
  update: ['source_row_index', 'player_name', 'jersey_number', 'class', 'position', 'height_in', 'weight', 'extra', 'value_states', 'provenance'] };
  await upsertRows(client, { ...rosterTable, conflict: '(school_season_id,player_source_path) WHERE player_source_path IS NOT NULL',
    rows: lastByKey(roster.filter((entry) => entry.path), (entry) => entry.path).map((entry) => entry.row) });
  await upsertRows(client, { ...rosterTable, conflict: '(school_season_id,source_row_index) WHERE player_source_path IS NULL',
    rows: roster.filter((entry) => !entry.path).map((entry) => entry.row) });

  await upsertRows(client, {
    table: 'team_season_stats', columns: ['school_season_id', 'side', 'games', ...CORE_STAT_FIELDS, 'extra', 'value_states', 'provenance'],
    update: ['games', ...CORE_STAT_FIELDS, 'extra', 'value_states', 'provenance'], conflict: '(school_season_id,side)',
    rows: (data.teamTotals ? ['team', 'opponent'] : []).map((side) => {
      const totals = data.teamTotals[side];
      const stats = statColumns(totals.stats);
      return [seasonId, side, presentValue(totals.games), ...stats.values, JSON.stringify(stats.extra),
        JSON.stringify({ ...valueStates({ games: totals.games }), ...stats.valueStates }), JSON.stringify(provenance)];
    }),
  });

  await upsertPlayerRows(client, {
    table: 'player_season_stats', owner: 'school_season_id',
    columns: ['player_name', 'games', 'games_started', ...CORE_STAT_FIELDS, 'advanced', 'extra', 'value_states', 'provenance'],
    entries: data.players.map((player, index) => {
      const stats = statColumns(player.stats);
      return { ownerId: seasonId, rowIndex: index, playerId: playerId(player), values: [player.name, presentValue(player.games),
        presentValue(player.gamesStarted), ...stats.values, JSON.stringify(player.advanced), JSON.stringify(stats.extra),
        JSON.stringify({ ...valueStates({ games: player.games, gamesStarted: player.gamesStarted }), ...stats.valueStates }),
        JSON.stringify(provenance)] };
    }),
  });
}

// Box scores do not state neutral-site context; the game-log rows that link a box
// score do. Any neutral row wins; otherwise a located row means not neutral.
async function resolveNeutralSite(client, providerId, boxScorePaths) {
  if (!boxScorePaths.length) return;
  await client.query(`UPDATE games g SET neutral_site = r.neutral FROM
    (SELECT canonical_box_score_path, bool_or(location = 'neutral') AS neutral FROM game_log_rows
      WHERE provider_id = $1 AND canonical_box_score_path = ANY($2::text[]) AND location IS NOT NULL
      GROUP BY canonical_box_score_path) r
    WHERE g.provider_id = $1 AND g.canonical_box_score_path = r.canonical_box_score_path AND r.neutral IS NOT NULL`,
  [providerId, boxScorePaths]);
}

async function writeGameLog(client, job, page, provenance, { replace = false } = {}) {
  const seasonId = await upsertSchoolSeason(client, job, page.data.endingYear, provenance);
  if (!seasonId) throw new Error('game log has no stored school identity');
  if (replace) {
    await client.query(`DELETE FROM game_log_row_stats WHERE game_log_row_id IN
      (SELECT id FROM game_log_rows WHERE school_season_id = $1)`, [seasonId]);
    await client.query('DELETE FROM game_log_rows WHERE school_season_id = $1', [seasonId]);
  }
  const games = page.data.games.map((row, index) => ({ row, index, boxScorePath: linkedPath(job.provider_id, row.boxScoreUrl, job.source_url) }));
  const logColumns = ['provider_id', 'school_season_id', 'source_row_index', 'game_number', 'game_date', 'location', 'opponent_name',
    'opponent_school_path', 'game_type', 'result', 'game_status', 'overtimes', 'team_score', 'opponent_score',
    'canonical_box_score_path', 'extra', 'value_states', 'provenance'];
  const logRows = await upsertRows(client, {
    table: 'game_log_rows', columns: logColumns, update: logColumns.slice(3), conflict: '(school_season_id,source_row_index)',
    returning: 'id,source_row_index',
    rows: games.map(({ row, index, boxScorePath }) => [job.provider_id, seasonId, index, row.gameNumber, row.date, row.location,
      row.opponent.name, linkedPath(job.provider_id, row.opponent.schoolPath, job.source_url), row.gameType, row.result, row.status,
      row.overtimes, presentValue(row.teamScore), presentValue(row.opponentScore), boxScorePath,
      JSON.stringify(row.extra ?? {}), JSON.stringify(valueStates({ teamScore: row.teamScore, opponentScore: row.opponentScore })),
      JSON.stringify(provenance)]),
  });
  const logRowId = new Map(logRows.map((row) => [row.source_row_index, row.id]));
  await upsertRows(client, {
    table: 'game_log_row_stats', columns: ['game_log_row_id', 'side', ...CORE_STAT_FIELDS, 'extra', 'value_states', 'provenance'],
    update: [...CORE_STAT_FIELDS, 'extra', 'value_states', 'provenance'], conflict: '(game_log_row_id,side)',
    rows: games.flatMap(({ row, index }) => [['team', row.teamStats], ['opponent', row.opponentStats]]
      .filter(([, line]) => line)
      .map(([side, line]) => {
        const stats = statColumns(line);
        return [logRowId.get(index), side, ...stats.values, JSON.stringify(stats.extra), JSON.stringify(stats.valueStates), JSON.stringify(provenance)];
      })),
  });
  await resolveNeutralSite(client, job.provider_id, [...new Set(games.map((game) => game.boxScorePath).filter(Boolean))]);
}

async function writeGame(client, job, page, provenance, { replace = false } = {}) {
  const data = page.data;
  const game = await client.query(`INSERT INTO games
    (provider_id,canonical_box_score_path,source_url,game_date,game_status,game_type,neutral_site,overtimes,line_scores,
     description,venue,attendance,extra,provenance)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13::jsonb,$14::jsonb)
    ON CONFLICT (provider_id,canonical_box_score_path) DO UPDATE SET
    source_url = EXCLUDED.source_url,game_date = EXCLUDED.game_date,game_status = EXCLUDED.game_status,
    game_type = EXCLUDED.game_type,neutral_site = COALESCE(EXCLUDED.neutral_site,games.neutral_site),
    overtimes = EXCLUDED.overtimes,line_scores = EXCLUDED.line_scores,description = EXCLUDED.description,
    venue = EXCLUDED.venue,attendance = EXCLUDED.attendance,extra = EXCLUDED.extra,provenance = EXCLUDED.provenance RETURNING id`,
  [job.provider_id, job.canonical_path, job.source_url, data.gameDate ?? null, data.status,
    data.gameType ?? null, data.neutralSite ?? null, data.overtimes ?? null,
    JSON.stringify(Object.fromEntries(data.teams.map((team) => [team.side, team.lineScore]))),
    data.description ?? null, data.venue ?? null, presentValue(data.attendance),
    JSON.stringify(data.extra ?? {}), JSON.stringify(provenance)]);
  const gameId = game.rows[0].id;
  if (replace) {
    const sides = '(SELECT id FROM game_teams WHERE game_id = $1)';
    await client.query(`DELETE FROM player_game_stats WHERE game_team_id IN ${sides}`, [gameId]);
    await client.query(`DELETE FROM team_game_stats WHERE game_team_id IN ${sides}`, [gameId]);
    await client.query('DELETE FROM game_teams WHERE game_id = $1', [gameId]);
  }
  const teams = lastByKey(data.teams, (team) => team.side);
  const sides = await upsertRows(client, {
    table: 'game_teams', columns: ['game_id', 'side', 'team_source_path', 'team_name', 'final_score', 'line_score', 'provenance'],
    update: ['team_source_path', 'team_name', 'final_score', 'line_score', 'provenance'], conflict: '(game_id,side)',
    returning: 'id,side',
    rows: teams.map((team) => [gameId, team.side, linkedPath(job.provider_id, team.schoolPath, job.source_url), team.name,
      presentValue(team.finalScore), JSON.stringify(team.lineScore), JSON.stringify(provenance)]),
  });
  const gameTeamId = new Map(sides.map((row) => [row.side, row.id]));
  await upsertRows(client, {
    table: 'team_game_stats', columns: ['game_team_id', ...CORE_STAT_FIELDS, 'advanced', 'extra', 'value_states', 'provenance'],
    update: [...CORE_STAT_FIELDS, 'advanced', 'extra', 'value_states', 'provenance'], conflict: '(game_team_id)',
    rows: teams.filter((team) => team.stats).map((team) => {
      const stats = statColumns(team.stats);
      return [gameTeamId.get(team.side), ...stats.values, JSON.stringify(team.advanced), JSON.stringify(stats.extra),
        JSON.stringify({ ...valueStates({ finalScore: team.finalScore }), ...stats.valueStates }), JSON.stringify(provenance)];
    }),
  });
  const playerId = await upsertPlayers(client, job, teams.flatMap((team) => team.players), provenance);
  await upsertPlayerRows(client, {
    table: 'player_game_stats', owner: 'game_team_id',
    columns: ['player_name', 'starter', ...CORE_STAT_FIELDS, 'advanced', 'extra', 'value_states', 'provenance'],
    entries: teams.flatMap((team) => team.players.map((player, index) => {
      const stats = statColumns(player.stats);
      return { ownerId: gameTeamId.get(team.side), rowIndex: index, playerId: playerId(player), values: [player.name, player.starter,
        ...stats.values, JSON.stringify(player.advanced), JSON.stringify(stats.extra), JSON.stringify(stats.valueStates),
        JSON.stringify(provenance)] };
    })),
  });
  await resolveNeutralSite(client, job.provider_id, [job.canonical_path]);
}

// A game-log row names its own school; the box score's team with the same school
// path is that side, so the row's scores are compared side by side.
async function recordLogConflict(client, providerId, schoolSourcePath, observation, sourceFetchId) {
  if (!observation.canonicalBoxScorePath || !schoolSourcePath) return;
  const path = unprefix(providerId, observation.canonicalBoxScorePath);
  const result = await client.query('SELECT id FROM games WHERE provider_id = $1 AND canonical_box_score_path = $2',
    [providerId, path]);
  if (!result.rowCount) return;
  const game = await client.query(`SELECT data,provenance FROM normalized_page_revisions
    WHERE provider_id = $1 AND record_key = $2 AND disposition = 'accepted' ORDER BY id DESC LIMIT 1`,
  [providerId, observation.canonicalBoxScorePath]);
  const accepted = game.rows[0];
  if (!accepted) return;
  const school = unprefix(providerId, schoolSourcePath);
  const baseUrl = accepted.provenance?.sourceUrl?.absoluteUrl;
  const own = (accepted.data.teams ?? []).find((team) => linkedPath(providerId, team.schoolPath, baseUrl) === school);
  if (!own) return;
  const other = accepted.data.teams.find((team) => team !== own);
  for (const [field, logged, team] of [['teamScore', observation.game?.teamScore, own], ['opponentScore', observation.game?.opponentScore, other]]) {
    const observed = presentValue(logged);
    const canonical = presentValue(team?.finalScore);
    if (observed !== null && observed !== canonical) {
      // Deduplicated on the school, field and both values, not on the fetch ids.
      await client.query(`INSERT INTO reconciliation_issues (issue_type,record_key,details,status,dedup_key)
        VALUES ('conflicting_game_log_fact',$1,$2::jsonb,'open',$3) ON CONFLICT DO NOTHING`,
      [observation.canonicalBoxScorePath, JSON.stringify({ field, observed, canonical,
        sourceFetchId: `fetch-${sourceFetchId}`, acceptedProvenance: accepted.provenance }),
      JSON.stringify([school, field, observed, canonical])]);
    }
  }
}

// accept (operator review, #48) commits a page that differs from the accepted
// revision as the new accepted one, as a supersede does, and marks its
// quarantined revision and observations accepted.
export async function writeNormalizedPage(client, job, page, provenance, sourceFetchId, { accept = false } = {}) {
  if (page.jobKey !== `${job.provider_id}:${job.canonical_path}:${job.page_type}`) throw new Error('page job identity mismatch');
  if (!page.identity || !page.kind || !page.data) throw new Error('normalized page is incomplete');
  const prior = await client.query(`SELECT r.id,r.data,r.provenance,r.parser_name,r.parser_version,f.checksum,
      r.data = $2::jsonb AS same
    FROM normalized_page_revisions r JOIN source_fetches f ON f.id = r.source_fetch_id
    WHERE r.provider_id = $1 AND r.record_key = $3 AND r.disposition = 'accepted' ORDER BY r.id DESC LIMIT 1`,
  [job.provider_id, JSON.stringify(page.data), page.identity]);
  const accepted = prior.rows[0];
  const differs = Boolean(accepted) && !accepted.same;
  // A parser change over the same raw body supersedes the accepted revision;
  // any other difference (the source changed) is quarantined for review.
  const superseded = differs && (accept || await parserChangeOnly(client, accepted, provenance, sourceFetchId));
  const conflict = differs && !superseded;
  const disposition = conflict ? 'quarantined' : 'accepted';
  const revision = await client.query(`INSERT INTO normalized_page_revisions
    (provider_id,record_key,page_type,source_fetch_id,parser_name,parser_version,data,provenance,disposition)
    VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9)
    ON CONFLICT (record_key,source_fetch_id,parser_name,parser_version)
    ${accept ? "DO UPDATE SET disposition = 'accepted'" : 'DO NOTHING'} RETURNING id`,
  [job.provider_id, page.identity, page.kind, sourceFetchId, provenance.parserName,
    provenance.parserVersion, JSON.stringify(page.data), JSON.stringify(provenance), disposition]);
  if (conflict && revision.rowCount) {
    // Deduplicated on the accepted revision and the conflicting content, so a
    // refetch of an unchanged conflicting page does not open a second issue.
    const previous = { data: accepted.data, provenance: accepted.provenance };
    await client.query(`INSERT INTO reconciliation_issues (issue_type,record_key,details,status,dedup_key)
      VALUES ('conflicting_page_reprocess',$1,$2::jsonb,'open',$3 || ':' || md5($4::jsonb::text)) ON CONFLICT DO NOTHING`,
    [page.identity, JSON.stringify({ previous, current: { data: page.data, provenance } }),
      `revision-${accepted.id}`, JSON.stringify(page.data)]);
  }
  // A superseding revision replaces the page's game-log observations.
  if (superseded) await client.query('DELETE FROM game_observations WHERE parent_job_id = $1', [job.id]);
  for (const [index, observation] of (page.observations ?? []).entries()) {
    const key = observation.key ?? `${observation.kind}:${observation.parentKey ?? page.jobKey}:${observation.rowIndex ?? observation.canonicalBoxScorePath ?? `row-${index}`}`;
    await client.query(`INSERT INTO page_observation_revisions
      (job_id,observation_key,source_fetch_id,observation,accepted) VALUES ($1,$2,$3,$4::jsonb,$5)
      ON CONFLICT (job_id,observation_key,source_fetch_id) ${accept ? 'DO UPDATE SET accepted = true' : 'DO NOTHING'}`,
    [job.id, key, sourceFetchId, JSON.stringify({ ...observation, provenance }), !conflict]);
    if (conflict) continue;
    if (observation.kind === 'game_log') {
      await client.query(`INSERT INTO game_observations
        (provider_id,canonical_box_score_path,parent_job_id,source_row_index,source_fetch_id,observation)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb)
        ON CONFLICT (provider_id,parent_job_id,source_row_index) DO UPDATE SET
        canonical_box_score_path = EXCLUDED.canonical_box_score_path,
        source_fetch_id = EXCLUDED.source_fetch_id,observation = EXCLUDED.observation`,
      [job.provider_id, observation.canonicalBoxScorePath ? unprefix(job.provider_id, observation.canonicalBoxScorePath) : null,
        job.id, observation.rowIndex, sourceFetchId, JSON.stringify({ ...observation, provenance })]);
      await recordLogConflict(client, job.provider_id, job.school_source_path, observation, sourceFetchId);
    }
  }
  const revisionId = revision.rows[0]?.id ?? null;
  if (conflict) return { key: page.identity, conflict: true, superseded: false, revisionId };

  const options = { replace: superseded };
  if (page.kind === 'school_index') await writeSchoolIndex(client, job, page, provenance);
  if (page.kind === 'school_history') await writeSchoolHistory(client, job, page, provenance);
  if (page.kind === 'season') await writeSeason(client, job, page, provenance, options);
  if (page.kind === 'game_log') await writeGameLog(client, job, page, provenance, options);
  if (page.kind === 'game') await writeGame(client, job, page, provenance, options);

  for (const missing of page.unavailableCoverage ?? []) {
    const result = await client.query(`INSERT INTO unavailable_coverage
      (provider_id,school_source_path,ending_year,reason,provenance)
      VALUES ($1,$2,$3,$4,$5::jsonb) ON CONFLICT (provider_id,school_source_path,ending_year)
      DO UPDATE SET reason = EXCLUDED.reason,provenance = EXCLUDED.provenance`,
    [job.provider_id, unprefix(job.provider_id, missing.schoolSourcePath), missing.endingYear,
      missing.reason, JSON.stringify(provenance)]);
    void result;
    const id = await schoolId(client, { ...job, school_source_path: missing.schoolSourcePath });
    if (id) await client.query(`INSERT INTO school_seasons (school_id,ending_year,coverage_status,provenance)
      VALUES ($1,$2,'unavailable',$3::jsonb) ON CONFLICT (school_id,ending_year) DO NOTHING`,
    [id, missing.endingYear, JSON.stringify(provenance)]);
  }

  for (const child of page.childJobs ?? []) {
    await client.query(`INSERT INTO crawl_jobs
      (provider_id,canonical_path,page_type,source_url,parent_job_id,school_source_path,parser_version)
      VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (provider_id,canonical_path,page_type) DO NOTHING`,
    [child.sourceUrl.providerId, canonicalPathString(child.canonicalPath), child.pageType,
      child.sourceUrl.absoluteUrl, job.id, child.schoolSourcePath ?? null, child.parserVersion ?? '1']);
  }

  if (page.kind === 'game') {
    const logRows = await client.query(`SELECT o.observation,o.source_fetch_id,j.school_source_path
      FROM game_observations o JOIN crawl_jobs j ON j.id = o.parent_job_id
      WHERE o.provider_id = $1 AND o.canonical_box_score_path = $2`, [job.provider_id, job.canonical_path]);
    for (const row of logRows.rows) {
      await recordLogConflict(client, job.provider_id, row.school_source_path, row.observation, row.source_fetch_id);
    }
  }
  return { key: page.identity, conflict: false, superseded, revisionId };
}

// True when the accepted revision was parsed from the same raw body (by
// checksum) as this one, by a different parser.
async function parserChangeOnly(client, accepted, provenance, sourceFetchId) {
  if (accepted.parser_name === provenance.parserName && accepted.parser_version === provenance.parserVersion) return false;
  if (!accepted.checksum) return false;
  const current = await client.query('SELECT checksum FROM source_fetches WHERE id = $1', [sourceFetchId]);
  return current.rows[0]?.checksum === accepted.checksum;
}
