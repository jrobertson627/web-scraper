import { canonicalPathString, canonicalizeSourceUrl, createSourceUrl } from '../contracts/source.mjs';

function canonicalFor(providerId, target, baseUrl) {
  if (!target) return null;
  const sourceUrl = createSourceUrl(providerId, target, baseUrl);
  const canonical = canonicalizeSourceUrl(sourceUrl);
  if (canonical.host !== new URL(baseUrl).host) throw new Error('linked identity must remain on the source host');
  return canonicalPathString(canonical);
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
  const path = canonicalFor(job.provider_id, player.sourcePath ?? player.sourceUrl ?? player.url, job.source_url);
  if (!path) return null;
  const result = await client.query(`INSERT INTO players (provider_id,canonical_source_path,display_name,provenance)
    VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT (provider_id,canonical_source_path)
    WHERE canonical_source_path IS NOT NULL DO UPDATE SET display_name = EXCLUDED.display_name,
    provenance = EXCLUDED.provenance RETURNING id`,
  [job.provider_id, path, player.name ?? player.playerName, JSON.stringify(provenance)]);
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

async function writeSeason(client, job, page, provenance) {
  const id = await schoolId(client, job);
  if (!id) throw new Error('season has no stored school identity');
  const season = await client.query(`INSERT INTO school_seasons (school_id,ending_year,coverage_status,provenance)
    VALUES ($1,$2,'linked',$3::jsonb) ON CONFLICT (school_id,ending_year)
    DO UPDATE SET coverage_status = 'linked',provenance = EXCLUDED.provenance RETURNING id`,
  [id, page.data.endingYear, JSON.stringify(provenance)]);
  for (const [index, player] of (page.data.roster ?? []).entries()) {
    const path = canonicalFor(job.provider_id, player.sourcePath ?? player.sourceUrl ?? player.url, job.source_url);
    await upsertPlayer(client, job, player, provenance);
    await client.query(`INSERT INTO season_rosters
      (school_season_id,source_row_index,player_source_path,player_name,provenance)
      VALUES ($1,$2,$3,$4,$5::jsonb) ON CONFLICT DO NOTHING`,
    [season.rows[0].id, player.rowIndex ?? index, path, player.name ?? player.playerName, JSON.stringify(provenance)]);
  }
}

async function writeGame(client, job, page, provenance) {
  const data = page.data;
  const game = await client.query(`INSERT INTO games
    (provider_id,canonical_box_score_path,source_url,game_date,game_status,game_type,neutral_site,overtime,line_scores,provenance)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb)
    ON CONFLICT (provider_id,canonical_box_score_path) DO UPDATE SET
    source_url = EXCLUDED.source_url,game_date = EXCLUDED.game_date,game_status = EXCLUDED.game_status,
    game_type = EXCLUDED.game_type,neutral_site = EXCLUDED.neutral_site,overtime = EXCLUDED.overtime,
    line_scores = EXCLUDED.line_scores,provenance = EXCLUDED.provenance RETURNING id`,
  [job.provider_id, job.canonical_path, job.source_url, data.gameDate ?? null, data.status,
    data.gameType ?? null, data.neutralSite ?? null, data.overtime == null ? null : String(data.overtime),
    JSON.stringify(data.lineScores ?? {}), JSON.stringify(provenance)]);
  const gameId = game.rows[0].id;
  for (const team of data.teams ?? []) {
    const path = canonicalFor(job.provider_id, team.sourcePath ?? team.sourceUrl, job.source_url);
    const side = await client.query(`INSERT INTO game_teams
      (game_id,side,team_source_path,team_name,final_score,provenance)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT (game_id,side) DO UPDATE SET
      team_source_path = EXCLUDED.team_source_path,team_name = EXCLUDED.team_name,
      final_score = EXCLUDED.final_score,provenance = EXCLUDED.provenance RETURNING id`,
    [gameId, team.side, path, team.name, team.finalScore ?? null, JSON.stringify(provenance)]);
    for (const [name, value] of Object.entries(team.stats ?? {})) {
      await client.query(`INSERT INTO team_game_stats (game_team_id,stat_name,value,provenance)
        VALUES ($1,$2,$3::jsonb,$4::jsonb) ON CONFLICT (game_team_id,stat_name)
        DO UPDATE SET value = EXCLUDED.value,provenance = EXCLUDED.provenance`,
      [side.rows[0].id, name, JSON.stringify(value), JSON.stringify(provenance)]);
    }
  }
  for (const [table, rows] of [['player_game_basic_stats', data.playerBasicStats ?? []],
    ['player_game_advanced_stats', data.playerAdvancedStats ?? []]]) {
    for (const [index, player] of rows.entries()) {
      const playerId = await upsertPlayer(client, job, player, provenance);
      const name = player.name ?? player.playerName;
      if (playerId) {
        await client.query(`INSERT INTO ${table} (game_id,source_row_index,player_id,player_name,stats,provenance)
          VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb) ON CONFLICT (game_id,player_id)
          WHERE player_id IS NOT NULL DO UPDATE SET source_row_index = EXCLUDED.source_row_index,
          player_name = EXCLUDED.player_name,stats = EXCLUDED.stats,provenance = EXCLUDED.provenance`,
        [gameId, player.rowIndex ?? index, playerId, name, JSON.stringify(player.stats ?? {}), JSON.stringify(provenance)]);
      } else {
        await client.query(`INSERT INTO ${table} (game_id,source_row_index,player_id,player_name,stats,provenance)
          VALUES ($1,$2,NULL,$3,$4::jsonb,$5::jsonb) ON CONFLICT (game_id,source_row_index)
          WHERE player_id IS NULL DO UPDATE SET player_name = EXCLUDED.player_name,
          stats = EXCLUDED.stats,provenance = EXCLUDED.provenance`,
        [gameId, player.rowIndex ?? index, name, JSON.stringify(player.stats ?? {}), JSON.stringify(provenance)]);
      }
    }
  }
}

async function recordLogConflict(client, job, observation, sourceFetchId) {
  if (!observation.canonicalBoxScorePath) return;
  const path = unprefix(job.provider_id, observation.canonicalBoxScorePath);
  const result = await client.query('SELECT id FROM games WHERE provider_id = $1 AND canonical_box_score_path = $2',
    [job.provider_id, path]);
  if (!result.rowCount) return;
  const game = await client.query(`SELECT data,provenance FROM normalized_page_revisions
    WHERE provider_id = $1 AND record_key = $2 AND disposition = 'accepted' ORDER BY id DESC LIMIT 1`,
  [job.provider_id, observation.canonicalBoxScorePath]);
  const accepted = game.rows[0];
  if (!accepted) return;
  for (const field of ['homeScore', 'awayScore']) {
    const observed = observation.game?.[field];
    const canonical = accepted.data[field];
    if (typeof observed === 'number' && observed !== canonical) {
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
      await recordLogConflict(client, job, observation, sourceFetchId);
    }
  }
  if (conflict) return { key: page.identity, conflict: true };

  if (page.kind === 'school_index') await writeSchoolIndex(client, job, page, provenance);
  if (page.kind === 'school_history') await writeSchoolHistory(client, job, page, provenance);
  if (page.kind === 'season') await writeSeason(client, job, page, provenance);
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
    const logRows = await client.query(`SELECT observation,source_fetch_id FROM game_observations
      WHERE provider_id = $1 AND canonical_box_score_path = $2`, [job.provider_id, job.canonical_path]);
    for (const row of logRows.rows) {
      await recordLogConflict(client, job, row.observation, row.source_fetch_id);
    }
  }
  return { key: page.identity, conflict: false };
}
