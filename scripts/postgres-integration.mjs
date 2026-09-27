import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { PostgresPersistence } from '../src/persistence/postgres.mjs';
import { createRawStore } from '../src/persistence/index.mjs';
import { createFixtureApplication, createWorkerApplication } from '../src/application/composition-root.mjs';
import { HttpTransport } from '../src/fetcher/http-transport.mjs';
import { createParseResult } from '../src/contracts/boundaries.mjs';
import { PAGE_TYPES } from '../src/contracts/source.mjs';
import { createProductionParserRegistry } from '../src/parsers/index.mjs';
import { createSourceUrl, canonicalizeSourceUrl, sourceKey } from '../src/contracts/source.mjs';
import { foundationCorpus } from '../fixtures/foundation-corpus.mjs';
import { boxScoreDocument, gameLogDocument, schoolIndexDocument, seasonDocument, statLine } from '../src/application/fixture-documents.mjs';
import { present, unavailable } from '../src/contracts/value-state.mjs';
// Adapter-hardening and API read-query checks share this disposable database.
import './postgres-ops-integration.mjs';

if (process.env.PG_TEST_CONFIRM !== 'disposable' || !process.env.PGHOST || !process.env.PGDATABASE || !process.env.PGUSER) {
  throw new Error('PostgreSQL integration tests require an explicitly disposable PG* database');
}

const { Pool } = pg;
const pool = new Pool({ max: 8 });
const localRoot = mkdtempSync(join(process.cwd(), '.tmp', 'postgres-test-'));
after(async () => { await pool.end(); });

async function reset() {
  const tables = await pool.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`);
  const names = tables.rows.map((row) => `"${row.tablename.replaceAll('"', '""')}"`);
  if (names.length) await pool.query(`TRUNCATE ${names.join(',')} RESTART IDENTITY CASCADE`);
}

function rootJob(path = '/cbb/schools/', pageType = 'school_index') {
  const sourceUrl = createSourceUrl('fixture-provider', `https://fixture.example${path}`);
  const canonicalPath = canonicalizeSourceUrl(sourceUrl);
  return { key: sourceKey(canonicalPath, pageType), pageType, sourceUrl, canonicalPath };
}

function sourceProvenance(job, fetchId) {
  return { providerId: job.sourceUrl.providerId, canonicalPath: job.canonicalPath,
    sourceUrl: job.sourceUrl, sourceFetchId: fetchId, parserName: job.pageType,
    parserVersion: '1', parsedAt: new Date().toISOString() };
}

function childRun(mode, rawRoot) {
  const child = spawn(process.execPath, ['scripts/postgres-worker-child.mjs', mode], {
    cwd: process.cwd(), env: { ...process.env, PG_TEST_RAW_ROOT: rawRoot },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
  });
  let stderr = '';
  child.stderr.on('data', (data) => { stderr += data.toString(); });
  const message = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('worker checkpoint timed out')), 20000);
    child.once('message', (value) => { clearTimeout(timer); resolve(value); });
    child.once('error', reject);
    child.once('exit', (code) => { if (code && code !== 0) reject(new Error(`worker exited ${code}: ${stderr}`)); });
  });
  const exit = new Promise((resolve) => child.once('exit', resolve));
  return { child, message, exit };
}

test('real PostgreSQL persistence and process restart', async () => {
  await reset();
  const persistence = new PostgresPersistence({ pool, claimTimeoutMs: 5000 });
  const job = rootJob();
  await persistence.addJob(job);

  await (async () => {
    const [first, other] = await Promise.all([
      persistence.claimNextJob(new Date(), 'worker-a'), persistence.claimNextJob(new Date(), 'worker-b'),
    ]);
    assert.equal([first, other].filter(Boolean).length, 1);
    const claimed = first ?? other;
    const request = await persistence.acquireRequest(job.key, claimed.lease, job.sourceUrl.host);
    assert.ok(request);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM in_flight_requests')).rows[0].n, 1);
    await delay(5200);
    assert.equal(await persistence.recoverExpiredClaims(), 0);
    assert.equal(await persistence.claimNextJob(new Date(), 'worker-c'), null);
    await persistence.confirmRequestCancellation(job.key, claimed.lease, 'child process exited; transport canceled');
    assert.equal(await persistence.recoverExpiredClaims(), 1);
    const replacement = await persistence.claimNextJob(new Date(), 'worker-c');
    assert.equal(replacement.lease.generation, claimed.lease.generation + 1);
    await assert.rejects(persistence.transitionJob(job.key, 'fetched', claimed.lease), /stale or missing lease/);
    await persistence.transitionJob(job.key, 'permanently_failed', replacement.lease, { lastError: 'test complete' });
  })();

  await (async () => {
    const row = await pool.query('SELECT id FROM crawl_jobs WHERE page_type = $1 LIMIT 1', ['school_index']);
    await assert.rejects(pool.query("UPDATE crawl_jobs SET state = 'fetching' WHERE id = $1", [row.rows[0].id]),
      (error) => error.code === '23514');
    await assert.rejects(pool.query(`INSERT INTO source_fetches
      (job_id,provider_id,canonical_path,http_status,fetched_at,checksum,raw_object_path)
      VALUES ($1,'fixture-provider','fixture.example/cbb/schools/ ',200,now(),'bad','file://bad')`, [row.rows[0].id]),
    (error) => error.code === '23514');
  })();

  await reset();
  await (async () => {
    const raw = createRawStore('filesystem', join(localRoot, 'raw-revisions'));
    await persistence.addJob(job);
    const claimed = await persistence.claimNextJob(new Date(), 'revision-worker');
    const firstBody = raw.put(Buffer.from('first'));
    const fetchId = await persistence.recordFetch({ jobKey: job.key, status: 200, ...firstBody }, claimed.lease, raw);
    const provenance = sourceProvenance(job, fetchId);
    const page = { jobKey: job.key, kind: 'school_index', identity: job.key,
      data: { schools: [{ path: '/school/a', name: 'Fixture A', to: 2026 }] },
      observations: [{ kind: 'school', parentKey: job.key, rowIndex: 0, eligible: true }] };
    await persistence.commitPage(page, provenance, claimed.lease);
    await persistence.commitPage(page, provenance, claimed.lease);
    const secondBody = raw.put(Buffer.from('second'));
    const secondId = await persistence.recordFetch({ jobKey: job.key, status: 200, ...secondBody }, claimed.lease, raw);
    const conflict = await persistence.commitPage({ ...page, data: { schools: [{ path: '/school/a', name: 'Different', to: 2026 }] } },
      sourceProvenance(job, secondId), claimed.lease);
    assert.equal(conflict.conflict, true);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM schools')).rows[0].n, 1);
    assert.equal((await pool.query('SELECT display_name FROM schools')).rows[0].display_name, 'Fixture A');
    assert.deepEqual((await pool.query('SELECT disposition FROM normalized_page_revisions ORDER BY id')).rows.map((row) => row.disposition),
      ['accepted', 'quarantined']);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM page_observation_revisions')).rows[0].n, 2);
  })();

  await reset();
  await (async () => {
    const raw = createRawStore('filesystem', join(localRoot, 'raw-domain'));
    await persistence.addJob(job);
    const indexClaim = await persistence.claimNextJob(new Date(), 'domain-worker');
    const indexRaw = raw.put(Buffer.from('index'));
    const indexFetch = await persistence.recordFetch({ jobKey: job.key, status: 200, ...indexRaw }, indexClaim.lease, raw);
    await persistence.transitionJob(job.key, 'fetched', indexClaim.lease, { sourceFetchId: indexFetch });
    await persistence.commitPageAndTransition({ jobKey: job.key, kind: 'school_index', identity: job.key,
      data: { schools: [{ path: '/school/a', name: 'Fixture A', to: 2026, aliases: ['A'] }] },
      observations: [{ kind: 'school', parentKey: job.key, rowIndex: 0, eligible: true }] },
    sourceProvenance(job, indexFetch), indexClaim.lease);

    const season = { ...rootJob('/school/a/men/2026.html', 'season'), parentKey: job.key,
      schoolSourcePath: 'fixture-provider:fixture.example/school/a' };
    await persistence.addJob(season);
    const seasonClaim = await persistence.claimNextJob(new Date(), 'domain-worker');
    assert.equal(seasonClaim.key, season.key);
    const seasonRaw = raw.put(Buffer.from('season'));
    const seasonFetch = await persistence.recordFetch({ jobKey: season.key, status: 200, ...seasonRaw }, seasonClaim.lease, raw);
    await persistence.transitionJob(season.key, 'fetched', seasonClaim.lease, { sourceFetchId: seasonFetch });
    const linked = { name: 'Linked Player', playerPath: '/players/linked' };
    const seasonData = seasonDocument({ school: 'Fixture A', endingYear: 2026, gameLogUrl: null,
      games: [{ status: 'final', teamScore: 70, opponentScore: 65, teamStats: statLine({ pts: 70 }), opponentStats: statLine({ pts: 65 }) }],
      players: [{ ...linked, lines: [statLine({ minutes: 32.5, pts: 0 })] }, { name: 'Unlinked Player', lines: [statLine({ pts: 4 })] }] });
    seasonData.summary.ncaaTournament = { seed: present(4), region: 'South', games: [
      { round: 'First Round', result: 'W', teamScore: 64, opponentScore: 47, opponent: { name: 'Vermont', seed: 13 } }] };
    await persistence.commitPageAndTransition({ jobKey: season.key, kind: 'season', identity: season.key, data: seasonData },
      sourceProvenance(season, seasonFetch), seasonClaim.lease);

    const log = { ...rootJob('/school/a/men/2026-gamelogs.html', 'game_log'), parentKey: season.key,
      schoolSourcePath: 'fixture-provider:fixture.example/school/a' };
    await persistence.addJob(log);
    const logClaim = await persistence.claimNextJob(new Date(), 'domain-worker');
    assert.equal(logClaim.key, log.key);
    const logRaw = raw.put(Buffer.from('log'));
    const logFetch = await persistence.recordFetch({ jobKey: log.key, status: 200, ...logRaw }, logClaim.lease, raw);
    await persistence.transitionJob(log.key, 'fetched', logClaim.lease, { sourceFetchId: logFetch });
    await persistence.commitPageAndTransition({ jobKey: log.key, kind: 'game_log', identity: log.key,
      data: gameLogDocument(2026, [
        { location: 'neutral', opponent: { name: 'Fixture B', schoolPath: '/school/b' }, boxScoreUrl: '/box/domain.html', status: 'final',
          date: '2026-01-02', teamScore: 70, opponentScore: 65, teamStats: statLine({ pts: 70 }), opponentStats: statLine({ pts: 65 }) },
        { location: 'away', opponent: { name: 'Division III', schoolPath: null }, status: 'incomplete' },
      ]) }, sourceProvenance(log, logFetch), logClaim.lease);

    const box = rootJob('/box/domain.html', 'box_score');
    await persistence.addJob(box);
    const boxClaim = await persistence.claimNextJob(new Date(), 'domain-worker');
    assert.equal(boxClaim.key, box.key);
    const boxRaw = raw.put(Buffer.from('box'));
    const boxFetch = await persistence.recordFetch({ jobKey: box.key, status: 200, ...boxRaw }, boxClaim.lease, raw);
    await persistence.transitionJob(box.key, 'fetched', boxClaim.lease, { sourceFetchId: boxFetch });
    const boxData = boxScoreDocument({ date: '2026-01-02', status: 'final',
      away: { name: 'Fixture B', schoolPath: '/school/b', score: 65, stats: statLine({ pts: 65 }) },
      home: { name: 'Fixture A', schoolPath: '/school/a', score: 70, stats: statLine({ pts: 70 }), players: [
        { ...linked, starter: true, stats: statLine({ minutes: 32.5, pts: 0 }) },
        { name: 'Unlinked Player', starter: false, stats: statLine({ pts: unavailable('not_published') }) },
      ] } });
    await persistence.commitPageAndTransition({ jobKey: box.key, kind: 'game', identity: 'fixture-provider:fixture.example/box/domain.html',
      data: { ...boxData, gameDate: boxData.date, context: null, neutralSite: null } }, sourceProvenance(box, boxFetch), boxClaim.lease);
    const counts = await pool.query(`SELECT
      (SELECT count(*) FROM school_aliases)::int AS aliases,
      (SELECT count(*) FROM school_seasons)::int AS seasons,
      (SELECT count(*) FROM season_rosters)::int AS rosters,
      (SELECT count(*) FROM players)::int AS players,
      (SELECT count(*) FROM team_seasons)::int AS team_seasons,
      (SELECT count(*) FROM team_season_stats)::int AS team_season_stats,
      (SELECT count(*) FROM player_season_stats)::int AS player_season_stats,
      (SELECT count(*) FROM game_log_rows)::int AS log_rows,
      (SELECT count(*) FROM game_log_row_stats)::int AS log_row_stats,
      (SELECT count(*) FROM team_game_stats)::int AS team_stats,
      (SELECT count(*) FROM player_game_stats)::int AS player_stats`);
    assert.deepEqual(counts.rows[0], { aliases: 1, seasons: 1, rosters: 2, players: 1, team_seasons: 1, team_season_stats: 2,
      player_season_stats: 2, log_rows: 2, log_row_stats: 2, team_stats: 2, player_stats: 2 });

    const teamSeason = await pool.query('SELECT wins,losses,ncaa_seed,ncaa_region,value_states FROM team_seasons');
    assert.deepEqual({ ...teamSeason.rows[0], value_states: Object.keys(teamSeason.rows[0].value_states).sort() },
      { wins: 1, losses: 0, ncaa_seed: 4, ncaa_region: 'South', value_states: ['confLosses', 'confWins', 'defRtg', 'offRtg', 'sos', 'srs'] });
    const lines = await pool.query(`SELECT player_name,minutes::float8 AS minutes,pts,value_states FROM player_game_stats ORDER BY source_row_index`);
    assert.deepEqual(lines.rows, [
      { player_name: 'Linked Player', minutes: 32.5, pts: 0, value_states: {} },
      { player_name: 'Unlinked Player', minutes: 0, pts: null, value_states: { pts: { state: 'unavailable', reason: 'not_published' } } },
    ]);
    const logRows = await pool.query(`SELECT location,opponent_school_path,result,game_status,team_score,canonical_box_score_path
      FROM game_log_rows ORDER BY source_row_index`);
    assert.deepEqual(logRows.rows, [
      { location: 'neutral', opponent_school_path: 'fixture.example/school/b', result: 'W', game_status: 'final', team_score: 70,
        canonical_box_score_path: 'fixture.example/box/domain.html' },
      { location: 'away', opponent_school_path: null, result: null, game_status: 'incomplete', team_score: null, canonical_box_score_path: null },
    ]);
    assert.equal((await pool.query('SELECT neutral_site FROM games')).rows[0].neutral_site, true);
  })();

  await reset();
  await (async () => {
    const raw = createRawStore('filesystem', join(localRoot, 'raw-rollback'));
    await persistence.addJob(job);
    const claimed = await persistence.claimNextJob(new Date(), 'rollback-worker');
    const body = raw.put(Buffer.from('rollback'));
    const fetchId = await persistence.recordFetch({ jobKey: job.key, status: 200, ...body }, claimed.lease, raw);
    await persistence.transitionJob(job.key, 'fetched', claimed.lease, { sourceFetchId: fetchId });
    await assert.rejects(persistence.commitPageAndTransition({ jobKey: job.key, kind: 'school_index', identity: job.key,
      data: { schools: [{ path: '/school/a', name: 'Fixture A', to: 2026 }] },
      observations: [{ kind: 'school', parentKey: job.key, rowIndex: 0, eligible: true }],
      childJobs: [{ ...rootJob('/invalid', 'season'), pageType: 'invalid_page_type' }] },
    sourceProvenance(job, fetchId), claimed.lease), (error) => error.code === '23514');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM schools')).rows[0].n, 0);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM normalized_page_revisions')).rows[0].n, 0);
    assert.equal((await persistence.getJob(job.key)).state, 'fetched');
  })();

  await reset();
  await (async () => {
    const reviewed = new PostgresPersistence({ pool, claimTimeoutMs: 5000,
      authorizeOperator: (operatorId) => operatorId === 'reviewer' });
    await reviewed.addJob(job);
    const first = await reviewed.claimNextJob(new Date(), 'operator-worker');
    await reviewed.transitionJob(job.key, 'operator_stop', first.lease, { lastError: 'challenge response' });
    await assert.rejects(reviewed.recordOperatorDisposition(job.key,
      { kind: 'release_retry', operatorId: 'unauthorized', reason: 'reviewed' }), /not authorized/);
    await reviewed.recordOperatorDisposition(job.key,
      { kind: 'release_retry', operatorId: 'reviewer', reason: 'safe to retry' });
    const retry = await reviewed.claimNextJob(new Date(), 'retry-worker');
    assert.equal(retry.lease.generation, first.lease.generation + 1);
    const raw = createRawStore('filesystem', join(localRoot, 'raw-repair'));
    const body = raw.put(Buffer.from('durable body'));
    const orphan = raw.put(Buffer.from('orphan body'));
    const fetchId = await reviewed.recordFetch({ jobKey: job.key, status: 200, ...body,
      cacheControl: 'max-age=120', cacheHit: true, reusedBody: true }, retry.lease, raw);
    assert.equal((await reviewed.lastSuccessfulFetch(job.key)).id, fetchId);
    assert.equal((await reviewed.lastSuccessfulFetch(job.key)).cacheControl, 'max-age=120');
    assert.equal((await reviewed.lastSuccessfulFetch(job.key)).cacheHit, true);
    const initial = await reviewed.repairRawObjects({ rawStore: raw });
    assert.equal(initial.healthy.length, 1);
    assert.equal(initial.orphans.some((entry) => entry.checksum === orphan.checksum), true);
    unlinkSync(body.objectPath.slice('file://'.length));
    const damaged = await reviewed.repairRawObjects({ rawStore: raw });
    assert.equal(damaged.pending.length, 1);
    assert.equal(damaged.pending[0].sourceFetchIds[0], fetchId);
  })();

  await reset();
  await (async () => {
    const slow = new PostgresPersistence({ pool, claimTimeoutMs: 250 });
    const raw = createRawStore('filesystem', join(localRoot, 'raw-slow'));
    const transport = { calls: [], async request({ url }) {
      this.calls.push(url);
      await delay(700);
      return { status: 200, headers: {}, body: Buffer.from('<script id="fixture-document" type="application/json">{"schools":[]}</script>') };
    } };
    const app = createFixtureApplication({ sharedState: { persistence: slow, rawStore: raw, transport } });
    const result = await app.runWorkerOnce();
    assert.equal(result.jobs.length, 1);
    assert.equal(result.jobs[0].state, 'parsed');
    assert.equal(transport.calls.length, 1);
  })();

  await reset();
  await (async () => {
    const ingest = new PostgresPersistence({ pool, claimTimeoutMs: 10000 });
    const raw = createRawStore('filesystem', join(localRoot, 'raw-fixture'));
    const app = createFixtureApplication({ fixtureEntries: foundationCorpus(), sharedState: { persistence: ingest, rawStore: raw } });
    const result = await app.runWorkerOnce();
    assert.equal(result.jobs.every((entry) => entry.state === 'parsed'), true);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM games')).rows[0].n, 6);
    const twoSided = await pool.query(`SELECT count(*)::int AS n FROM game_teams t JOIN games g ON g.id = t.game_id
      WHERE g.canonical_box_score_path = 'fixture.example/box/one.html'`);
    assert.equal(twoSided.rows[0].n, 2);
    const logSides = await pool.query(`SELECT count(*)::int AS n FROM game_observations
      WHERE canonical_box_score_path = 'fixture.example/box/one.html'`);
    assert.equal(logSides.rows[0].n, 2);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM unavailable_coverage')).rows[0].n, 7);
    const stored = await pool.query(`SELECT
      (SELECT count(*) FROM game_log_rows)::int AS log_rows,
      (SELECT count(*) FROM game_log_row_stats)::int AS log_row_stats,
      (SELECT count(*) FROM team_season_stats)::int AS team_season_stats,
      (SELECT count(*) FROM player_game_stats)::int AS player_stats`);
    assert.deepEqual(stored.rows[0], { log_rows: 8, log_row_stats: 6, team_season_stats: 6, player_stats: 4 });
    const neutral = await pool.query(`SELECT canonical_box_score_path AS path,neutral_site FROM games
      WHERE canonical_box_score_path IN ('fixture.example/box/one.html','fixture.example/box/four.html') ORDER BY 1`);
    assert.deepEqual(neutral.rows, [{ path: 'fixture.example/box/four.html', neutral_site: true },
      { path: 'fixture.example/box/one.html', neutral_site: false }]);
    assert.equal((await app.queries.listGames()).items.length, 6);
    const server = app.createApiServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      const response = await fetch(`${base}/games`);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).length, 6);
    } finally {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    const resumed = createFixtureApplication({ fixtureEntries: foundationCorpus(), sharedState: { persistence: ingest, rawStore: raw } });
    assert.equal((await resumed.runWorkerOnce()).processed, 0);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM games')).rows[0].n, 6);
  })();

  await reset();
  await (async () => {
    const fixtures = foundationCorpus().map((entry) => entry.url.endsWith('/school/a/men/2026-gamelogs.html')
      ? { ...entry, body: entry.body.replace('"teamScore":{"state":"present","value":70}', '"teamScore":{"state":"present","value":71}') } : entry);
    const ingest = new PostgresPersistence({ pool, claimTimeoutMs: 10000 });
    const raw = createRawStore('filesystem', join(localRoot, 'raw-log-conflict'));
    const app = createFixtureApplication({ fixtureEntries: fixtures, sharedState: { persistence: ingest, rawStore: raw } });
    await app.runWorkerOnce();
    const conflicts = await pool.query(`SELECT details FROM reconciliation_issues
      WHERE issue_type = 'conflicting_game_log_fact' AND record_key = 'fixture-provider:fixture.example/box/one.html'`);
    assert.equal(conflicts.rowCount, 1);
    assert.equal(conflicts.rows[0].details.observed, 71);
    assert.equal(conflicts.rows[0].details.canonical, 70);
    assert.ok(conflicts.rows[0].details.acceptedProvenance.sourceFetchId);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM games
      WHERE canonical_box_score_path = 'fixture.example/box/one.html'`)).rows[0].n, 1);
  })();

  await reset();
  await (async () => {
    const rawRoot = join(localRoot, 'raw-process');
    const interrupted = childRun('crash', rawRoot);
    const checkpoint = await interrupted.message;
    assert.equal(checkpoint.checkpoint, 'before-page-commit');
    const parsedBefore = (await pool.query("SELECT count(*)::int AS n FROM crawl_jobs WHERE state = 'parsed'")).rows[0].n;
    assert.ok(parsedBefore > 0);
    interrupted.child.kill();
    await interrupted.exit;
    await delay(2100);
    const replacement = childRun('resume', rawRoot);
    const done = await replacement.message;
    assert.equal(done.done, true);
    await replacement.exit;
    const state = await pool.query('SELECT state,attempts FROM crawl_jobs WHERE provider_id = $1 AND page_type = $2', ['fixture-provider', 'school_index']);
    assert.equal(state.rows[0].state, 'parsed');
    assert.equal(state.rows[0].attempts, 1);
    const formerlyClaimed = await persistence.getJob(checkpoint.jobKey);
    assert.equal(formerlyClaimed.state, 'parsed');
    assert.equal(formerlyClaimed.attempts, 2);
    assert.ok(formerlyClaimed.history.some((event) => event.to === 'retry_wait'));
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM games')).rows[0].n, 6);
  })();

  await reset();
  await (async () => {
    // The production worker assembly against real PostgreSQL, with the real clock
    // and sleep. The transport is an HttpTransport that answers locally, and the
    // index lists no eligible school, so the run makes exactly one request.
    class LocalHttpTransport extends HttpTransport {
      calls = [];
      async request({ url }) { this.calls.push(url); return { status: 200, headers: {}, body: Buffer.from('<html>school index</html>') }; }
    }
    const indexParser = { pageType: () => 'school_index', version: () => '1', parse: () => createParseResult({ kind: 'valid',
      document: schoolIndexDocument([{ name: 'Former School', path: '/cbb/schools/former/men/', historyUrl: 'https://www.sports-reference.com/cbb/schools/former/men/', to: 2020 }]) }) };
    const unused = (pageType) => ({ pageType: () => pageType, version: () => '1', parse: () => createParseResult({ kind: 'structural_failure', error: 'not expected' }) });
    const record = (name) => JSON.parse(readFileSync(new URL(`../config/personal-use.${name}.json`, import.meta.url), 'utf8'));
    const transport = new LocalHttpTransport();
    const worker = await createWorkerApplication({
      config: {
        mode: 'worker', providerId: 'sports-reference', allowedHosts: ['www.sports-reference.com'],
        rawStore: 'filesystem', rawStoreRoot: join(localRoot, 'raw-worker'), publication: 'private',
        policy: { minIntervalMs: 6000, maxRequestsPerMinute: 10, hostConcurrency: 1, userAgent: 'web-scraper-test (+ops@example.com)' },
        eligibilityPredicate: 'To == 2026', targetEndingYears: [2022, 2023, 2024, 2025, 2026],
        authorization: record('authorization'), dataContract: record('data-contract'),
      },
      transport,
      persistence: new PostgresPersistence({ pool, claimTimeoutMs: 10000 }),
      parsers: createProductionParserRegistry([indexParser, ...PAGE_TYPES.filter((type) => type !== 'school_index').map(unused)]),
    });
    const result = await worker.runWorkerOnce('assembly-worker');
    assert.deepEqual(transport.calls, ['https://www.sports-reference.com/cbb/schools/']);
    assert.equal(result.processed, 1);
    assert.deepEqual(result.jobs.map((job) => [job.key, job.state]), [['sports-reference:www.sports-reference.com/cbb/schools:school_index', 'parsed']]);
    const schedule = await pool.query('SELECT last_request_started_at FROM host_request_schedule WHERE host = $1', ['www.sports-reference.com']);
    assert.ok(Math.abs(new Date(schedule.rows[0].last_request_started_at).getTime() - Date.now()) < 60_000, 'request schedule holds real time');
    await worker.seedRootJob();
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM crawl_jobs')).rows[0].n, 1);
  })();
});

// Records every statement a persistence call sends, so the exact SQL can be
// EXPLAINed afterwards.
function recordingPool(target) {
  const statements = [];
  const wrap = (client) => ({ query: (text, values) => { statements.push({ text, values }); return client.query(text, values); },
    release: () => client.release() });
  return { statements, query: (text, values) => { statements.push({ text, values }); return target.query(text, values); },
    connect: async () => wrap(await target.connect()), end: async () => {} };
}

async function explain(statements, label) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL enable_seqscan = off');
    for (const { text, values } of statements) {
      const plan = (await client.query(`EXPLAIN ${text}`, values)).rows.map((row) => row['QUERY PLAN']).join('\n');
      assert.doesNotMatch(plan, /Seq Scan on crawl_jobs/, `${label}: ${text}\n${plan}`);
      assert.match(plan, /Index (Only )?Scan|Bitmap Index Scan/, `${label}: ${text}\n${plan}`);
    }
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

test('lease checks, renewals, transitions and fetch records use an index on crawl_jobs', async () => {
  await reset();
  const setup = new PostgresPersistence({ pool, claimTimeoutMs: 30_000 });
  for (let index = 0; index < 50; index += 1) await setup.addJob(rootJob(`/filler/${index}`, 'season'));
  const job = rootJob();
  await setup.addJob(job);
  await pool.query('ANALYZE crawl_jobs');
  let claimed;
  while ((claimed = await setup.claimNextJob(new Date(), 'explain-worker')).key !== job.key) { /* claim past the filler */ }
  const recorder = recordingPool(pool);
  const persistence = new PostgresPersistence({ pool: recorder, claimTimeoutMs: 30_000 });
  const raw = createRawStore('filesystem', join(localRoot, 'raw-explain'));
  const body = raw.put(Buffer.from('explain'));
  for (const [label, call] of [
    ['lease check and recordFetch', () => persistence.recordFetch({ jobKey: job.key, status: 200, ...body }, claimed.lease, raw)],
    ['renewClaim', () => persistence.renewClaim(job.key, claimed.lease)],
    ['transitionJob', () => persistence.transitionJob(job.key, 'fetched', claimed.lease)],
  ]) {
    recorder.statements.length = 0;
    await call();
    const lookups = recorder.statements.filter(({ text }) => /crawl_jobs/.test(text) && /^\s*(SELECT|UPDATE)/.test(text));
    assert.ok(lookups.length > 0, label);
    await explain(lookups, label);
  }
});

// Shifts the process clock (new Date() and Date.now()) while the database
// clock stays put. Dates built from explicit values are unaffected.
async function withSkewedProcessClock(skewMs, action) {
  const RealDate = globalThis.Date;
  class SkewedDate extends RealDate {
    constructor(...args) { if (args.length) super(...args); else super(RealDate.now() + skewMs); }
    static now() { return RealDate.now() + skewMs; }
  }
  globalThis.Date = SkewedDate;
  try { return await action(); } finally { globalThis.Date = RealDate; }
}

test('a process clock skewed from the database clock neither rejects a valid lease nor accepts an expired one', async () => {
  for (const skewMs of [3_600_000, -3_600_000]) {
    await reset();
    const persistence = new PostgresPersistence({ pool, claimTimeoutMs: 1500 });
    const job = rootJob();
    await persistence.addJob(job);
    await withSkewedProcessClock(skewMs, async () => {
      const claimed = await persistence.claimNextJob(new Date(), 'skewed-worker');
      await persistence.renewClaim(job.key, claimed.lease, new Date());
      await persistence.transitionJob(job.key, 'fetched', claimed.lease);
      await delay(1700);
      await assert.rejects(persistence.transitionJob(job.key, 'parsed', claimed.lease), /stale or missing lease/);
      await assert.rejects(persistence.renewClaim(job.key, claimed.lease, new Date()), /stale or missing lease/);
      assert.equal(await persistence.recoverExpiredClaims(new Date()), 1);
    });
  }
});
