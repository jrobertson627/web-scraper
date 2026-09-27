import { CORE_STAT_FIELDS } from '../contracts/parsed-documents.mjs';
import { canonicalPathString, canonicalizeSourceUrl, createSourceUrl } from '../contracts/source.mjs';

const CORE_COLUMNS = CORE_STAT_FIELDS.join(',');
const CORE_UPDATES = CORE_STAT_FIELDS.map((field) => `${field} = EXCLUDED.${field}`).join(',');

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

function placeholders(from, count) { return Array.from({ length: count }, (_, index) => `$${from + index}`).join(','); }

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

async function upsertPlayer(client, job, player, provenance) {
  const path = linkedPath(job.provider_id, player.playerPath, job.source_url);
  if (!path) return null;
  const result = await client.query(`INSERT INTO players (provider_id,canonical_source_path,display_name,provenance)
    VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT (provider_id,canonical_source_path)
    WHERE canonical_source_path IS NOT NULL DO UPDATE SET display_name = EXCLUDED.display_name,
    provenance = EXCLUDED.provenance RETURNING id`,
  [job.provider_id, path, player.name, JSON.stringify(provenance)]);
  return result.rows[0].id;
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

// Upserts a row keyed by a player link when there is one, else by source row.
async function upsertPlayerRow(client, { table, owner, ownerId, rowIndex, playerId, columns, values }) {
  const names = [owner, 'source_row_index', 'player_id', ...columns];
  const updates = ['source_row_index', ...columns].map((column) => `${column} = EXCLUDED.${column}`).join(',');
  const conflict = playerId
    ? `(${owner},player_id) WHERE player_id IS NOT NULL`
    : `(${owner},source_row_index) WHERE player_id IS NULL`;
  await client.query(`INSERT INTO ${table} (${names.join(',')}) VALUES (${placeholders(1, names.length)})
    ON CONFLICT ${conflict} DO UPDATE SET ${updates}`, [ownerId, rowIndex, playerId, ...values]);
}

async function writeSeason(client, job, page, provenance) {
  const data = page.data;
  const seasonId = await upsertSchoolSeason(client, job, data.endingYear, provenance);
  if (!seasonId) throw new Error('season has no stored school identity');
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

  for (const [index, player] of data.roster.entries()) {
    const path = linkedPath(job.provider_id, player.playerPath, job.source_url);
    await upsertPlayer(client, job, player, provenance);
    const conflict = path
      ? '(school_season_id,player_source_path) WHERE player_source_path IS NOT NULL'
      : '(school_season_id,source_row_index) WHERE player_source_path IS NULL';
    await client.query(`INSERT INTO season_rosters
      (school_season_id,source_row_index,player_source_path,player_name,jersey_number,class,position,height_in,weight,
       extra,value_states,provenance)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb) ON CONFLICT ${conflict} DO UPDATE SET
      source_row_index = EXCLUDED.source_row_index,player_name = EXCLUDED.player_name,jersey_number = EXCLUDED.jersey_number,
      class = EXCLUDED.class,position = EXCLUDED.position,height_in = EXCLUDED.height_in,weight = EXCLUDED.weight,
      extra = EXCLUDED.extra,value_states = EXCLUDED.value_states,provenance = EXCLUDED.provenance`,
    [seasonId, index, path, player.name, player.number, player.class, player.position,
      presentValue(player.heightIn), presentValue(player.weight), JSON.stringify(player.extra ?? {}),
      JSON.stringify(valueStates({ heightIn: player.heightIn, weight: player.weight })), JSON.stringify(provenance)]);
  }

  for (const side of data.teamTotals ? ['team', 'opponent'] : []) {
    const totals = data.teamTotals[side];
    const stats = statColumns(totals.stats);
    await client.query(`INSERT INTO team_season_stats
      (school_season_id,side,games,${CORE_COLUMNS},extra,value_states,provenance)
      VALUES ($1,$2,$3,${placeholders(4, CORE_STAT_FIELDS.length)},$20::jsonb,$21::jsonb,$22::jsonb)
      ON CONFLICT (school_season_id,side) DO UPDATE SET games = EXCLUDED.games,${CORE_UPDATES},
      extra = EXCLUDED.extra,value_states = EXCLUDED.value_states,provenance = EXCLUDED.provenance`,
    [seasonId, side, presentValue(totals.games), ...stats.values, JSON.stringify(stats.extra),
      JSON.stringify({ ...valueStates({ games: totals.games }), ...stats.valueStates }), JSON.stringify(provenance)]);
  }

  for (const [index, player] of data.players.entries()) {
    const playerId = await upsertPlayer(client, job, player, provenance);
    const stats = statColumns(player.stats);
    await upsertPlayerRow(client, {
      table: 'player_season_stats', owner: 'school_season_id', ownerId: seasonId, rowIndex: index, playerId,
      columns: ['player_name', 'games', 'games_started', ...CORE_STAT_FIELDS, 'advanced', 'extra', 'value_states', 'provenance'],
      values: [player.name, presentValue(player.games), presentValue(player.gamesStarted), ...stats.values,
        JSON.stringify(player.advanced), JSON.stringify(stats.extra),
        JSON.stringify({ ...valueStates({ games: player.games, gamesStarted: player.gamesStarted }), ...stats.valueStates }),
        JSON.stringify(provenance)],
    });
  }
}

// Box scores do not state neutral-site context; the game-log rows that link a box
// score do. Any neutral row wins; otherwise a located row means not neutral.
async function resolveNeutralSite(client, providerId, boxScorePath) {
  await client.query(`UPDATE games g SET neutral_site = r.neutral FROM
    (SELECT bool_or(location = 'neutral') AS neutral FROM game_log_rows
      WHERE provider_id = $1 AND canonical_box_score_path = $2 AND location IS NOT NULL) r
    WHERE g.provider_id = $1 AND g.canonical_box_score_path = $2 AND r.neutral IS NOT NULL`,
  [providerId, boxScorePath]);
}

async function writeGameLog(client, job, page, provenance) {
  const seasonId = await upsertSchoolSeason(client, job, page.data.endingYear, provenance);
  if (!seasonId) throw new Error('game log has no stored school identity');
  const boxScorePaths = new Set();
  for (const [index, row] of page.data.games.entries()) {
    const boxScorePath = linkedPath(job.provider_id, row.boxScoreUrl, job.source_url);
    if (boxScorePath) boxScorePaths.add(boxScorePath);
    const logRow = await client.query(`INSERT INTO game_log_rows
      (provider_id,school_season_id,source_row_index,game_number,game_date,location,opponent_name,opponent_school_path,
       game_type,result,game_status,overtimes,team_score,opponent_score,canonical_box_score_path,extra,value_states,provenance)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17::jsonb,$18::jsonb)
      ON CONFLICT (school_season_id,source_row_index) DO UPDATE SET game_number = EXCLUDED.game_number,
      game_date = EXCLUDED.game_date,location = EXCLUDED.location,opponent_name = EXCLUDED.opponent_name,
      opponent_school_path = EXCLUDED.opponent_school_path,game_type = EXCLUDED.game_type,result = EXCLUDED.result,
      game_status = EXCLUDED.game_status,overtimes = EXCLUDED.overtimes,team_score = EXCLUDED.team_score,
      opponent_score = EXCLUDED.opponent_score,canonical_box_score_path = EXCLUDED.canonical_box_score_path,
      extra = EXCLUDED.extra,value_states = EXCLUDED.value_states,provenance = EXCLUDED.provenance RETURNING id`,
    [job.provider_id, seasonId, index, row.gameNumber, row.date, row.location, row.opponent.name,
      linkedPath(job.provider_id, row.opponent.schoolPath, job.source_url), row.gameType, row.result, row.status,
      row.overtimes, presentValue(row.teamScore), presentValue(row.opponentScore), boxScorePath,
      JSON.stringify(row.extra ?? {}), JSON.stringify(valueStates({ teamScore: row.teamScore, opponentScore: row.opponentScore })),
      JSON.stringify(provenance)]);
    for (const [side, line] of [['team', row.teamStats], ['opponent', row.opponentStats]]) {
      if (!line) continue;
      const stats = statColumns(line);
      await client.query(`INSERT INTO game_log_row_stats
        (game_log_row_id,side,${CORE_COLUMNS},extra,value_states,provenance)
        VALUES ($1,$2,${placeholders(3, CORE_STAT_FIELDS.length)},$19::jsonb,$20::jsonb,$21::jsonb)
        ON CONFLICT (game_log_row_id,side) DO UPDATE SET ${CORE_UPDATES},
        extra = EXCLUDED.extra,value_states = EXCLUDED.value_states,provenance = EXCLUDED.provenance`,
      [logRow.rows[0].id, side, ...stats.values, JSON.stringify(stats.extra), JSON.stringify(stats.valueStates), JSON.stringify(provenance)]);
    }
  }
  for (const path of boxScorePaths) await resolveNeutralSite(client, job.provider_id, path);
}

async function writeGame(client, job, page, provenance) {
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
  for (const team of data.teams) {
    const side = await client.query(`INSERT INTO game_teams
      (game_id,side,team_source_path,team_name,final_score,line_score,provenance)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb) ON CONFLICT (game_id,side) DO UPDATE SET
      team_source_path = EXCLUDED.team_source_path,team_name = EXCLUDED.team_name,
      final_score = EXCLUDED.final_score,line_score = EXCLUDED.line_score,provenance = EXCLUDED.provenance RETURNING id`,
    [gameId, team.side, linkedPath(job.provider_id, team.schoolPath, job.source_url), team.name,
      presentValue(team.finalScore), JSON.stringify(team.lineScore), JSON.stringify(provenance)]);
    const gameTeamId = side.rows[0].id;
    if (team.stats) {
      const stats = statColumns(team.stats);
      await client.query(`INSERT INTO team_game_stats
        (game_team_id,${CORE_COLUMNS},advanced,extra,value_states,provenance)
        VALUES ($1,${placeholders(2, CORE_STAT_FIELDS.length)},$18::jsonb,$19::jsonb,$20::jsonb,$21::jsonb)
        ON CONFLICT (game_team_id) DO UPDATE SET ${CORE_UPDATES},advanced = EXCLUDED.advanced,
        extra = EXCLUDED.extra,value_states = EXCLUDED.value_states,provenance = EXCLUDED.provenance`,
      [gameTeamId, ...stats.values, JSON.stringify(team.advanced), JSON.stringify(stats.extra),
        JSON.stringify({ ...valueStates({ finalScore: team.finalScore }), ...stats.valueStates }), JSON.stringify(provenance)]);
    }
    for (const [index, player] of team.players.entries()) {
      const playerId = await upsertPlayer(client, job, player, provenance);
      const stats = statColumns(player.stats);
      await upsertPlayerRow(client, {
        table: 'player_game_stats', owner: 'game_team_id', ownerId: gameTeamId, rowIndex: index, playerId,
        columns: ['player_name', 'starter', ...CORE_STAT_FIELDS, 'advanced', 'extra', 'value_states', 'provenance'],
        values: [player.name, player.starter, ...stats.values, JSON.stringify(player.advanced), JSON.stringify(stats.extra),
          JSON.stringify(stats.valueStates), JSON.stringify(provenance)],
      });
    }
  }
  await resolveNeutralSite(client, job.provider_id, job.canonical_path);
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
      await client.query(`INSERT INTO reconciliation_issues (issue_type,record_key,details,status)
        VALUES ('conflicting_game_log_fact',$1,$2::jsonb,'open') ON CONFLICT DO NOTHING`,
      [observation.canonicalBoxScorePath, JSON.stringify({ field, observed, canonical,
        sourceFetchId: `fetch-${sourceFetchId}`, acceptedProvenance: accepted.provenance })]);
    }
  }
}

export async function writeNormalizedPage(client, job, page, provenance, sourceFetchId) {
  if (page.jobKey !== `${job.provider_id}:${job.canonical_path}:${job.page_type}`) throw new Error('page job identity mismatch');
  if (!page.identity || !page.kind || !page.data) throw new Error('normalized page is incomplete');
  const prior = await client.query(`SELECT data,provenance,data = $2::jsonb AS same
    FROM normalized_page_revisions WHERE provider_id = $1 AND record_key = $3
      AND disposition = 'accepted' ORDER BY id DESC LIMIT 1`,
  [job.provider_id, JSON.stringify(page.data), page.identity]);
  const conflict = prior.rowCount > 0 && !prior.rows[0].same;
  const disposition = conflict ? 'quarantined' : 'accepted';
  const revision = await client.query(`INSERT INTO normalized_page_revisions
    (provider_id,record_key,page_type,source_fetch_id,parser_name,parser_version,data,provenance,disposition)
    VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9)
    ON CONFLICT (record_key,source_fetch_id,parser_name,parser_version) DO NOTHING RETURNING id`,
  [job.provider_id, page.identity, page.kind, sourceFetchId, provenance.parserName,
    provenance.parserVersion, JSON.stringify(page.data), JSON.stringify(provenance), disposition]);
  if (conflict && revision.rowCount) {
    await client.query(`INSERT INTO reconciliation_issues (issue_type,record_key,details,status)
      VALUES ('conflicting_page_reprocess',$1,$2::jsonb,'open') ON CONFLICT DO NOTHING`,
    [page.identity, JSON.stringify({ previous: prior.rows[0], current: { data: page.data, provenance } })]);
  }
  for (const [index, observation] of (page.observations ?? []).entries()) {
    const key = observation.key ?? `${observation.kind}:${observation.parentKey ?? page.jobKey}:${observation.rowIndex ?? observation.canonicalBoxScorePath ?? `row-${index}`}`;
    await client.query(`INSERT INTO page_observation_revisions
      (job_id,observation_key,source_fetch_id,observation,accepted) VALUES ($1,$2,$3,$4::jsonb,$5)
      ON CONFLICT DO NOTHING`, [job.id, key, sourceFetchId, JSON.stringify({ ...observation, provenance }), !conflict]);
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
  if (conflict) return { key: page.identity, conflict: true };

  if (page.kind === 'school_index') await writeSchoolIndex(client, job, page, provenance);
  if (page.kind === 'school_history') await writeSchoolHistory(client, job, page, provenance);
  if (page.kind === 'season') await writeSeason(client, job, page, provenance);
  if (page.kind === 'game_log') await writeGameLog(client, job, page, provenance);
  if (page.kind === 'game') await writeGame(client, job, page, provenance);

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
  return { key: page.identity, conflict: false };
}
