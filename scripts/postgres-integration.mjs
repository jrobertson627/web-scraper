import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { PostgresPersistence } from '../src/persistence/postgres.mjs';
import { createRawStore } from '../src/persistence/index.mjs';
import { createFixtureApplication } from '../src/application/composition-root.mjs';
import { createSourceUrl, canonicalizeSourceUrl, sourceKey } from '../src/contracts/source.mjs';
import { foundationCorpus } from '../fixtures/foundation-corpus.mjs';

if (process.env.PG_TEST_CONFIRM !== 'disposable' || !process.env.PGHOST || !process.env.PGDATABASE || !process.env.PGUSER) {
  throw new Error('PostgreSQL integration tests require an explicitly disposable PG* database');
}

const { Pool } = pg;
const pool = new Pool({ max: 8 });
const localRoot = mkdtempSync(join(process.cwd(), '.tmp', 'postgres-test-'));

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

test('real PostgreSQL persistence and process restart', async (t) => {
  t.after(async () => { await pool.end(); });
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
    await persistence.commitPageAndTransition({ jobKey: season.key, kind: 'season', identity: season.key,
      data: { endingYear: 2026, roster: [
        { name: 'Linked Player', sourcePath: '/players/linked', stats: { points: 0 } },
        { name: 'Unlinked Player' },
      ] } }, sourceProvenance(season, seasonFetch), seasonClaim.lease);

    const box = rootJob('/box/domain.html', 'box_score');
    await persistence.addJob(box);
    const boxClaim = await persistence.claimNextJob(new Date(), 'domain-worker');
    assert.equal(boxClaim.key, box.key);
    const boxRaw = raw.put(Buffer.from('box'));
    const boxFetch = await persistence.recordFetch({ jobKey: box.key, status: 200, ...boxRaw }, boxClaim.lease, raw);
    await persistence.transitionJob(box.key, 'fetched', boxClaim.lease, { sourceFetchId: boxFetch });
    await persistence.commitPageAndTransition({ jobKey: box.key, kind: 'game', identity: 'fixture-provider:fixture.example/box/domain.html',
      data: { gameDate: '2026-01-02', status: 'final', teams: [
        { side: 'home', name: 'Fixture A', finalScore: 70, stats: { rebounds: { state: 'present', value: 0 } } },
        { side: 'away', name: 'Fixture B', finalScore: 65 },
      ], playerBasicStats: [
        { name: 'Linked Player', sourcePath: '/players/linked', stats: { points: { state: 'present', value: 0 } } },
        { name: 'Unlinked Player', stats: { points: { state: 'unavailable', reason: 'not_published' } } },
      ], playerAdvancedStats: [
        { name: 'Linked Player', sourcePath: '/players/linked', stats: { usage: { state: 'blank' } } },
      ] } }, sourceProvenance(box, boxFetch), boxClaim.lease);
    const counts = await pool.query(`SELECT
      (SELECT count(*) FROM school_aliases)::int AS aliases,
      (SELECT count(*) FROM school_seasons)::int AS seasons,
      (SELECT count(*) FROM season_rosters)::int AS rosters,
      (SELECT count(*) FROM players)::int AS players,
      (SELECT count(*) FROM team_game_stats)::int AS team_stats,
      (SELECT count(*) FROM player_game_basic_stats)::int AS basic_stats,
      (SELECT count(*) FROM player_game_advanced_stats)::int AS advanced_stats`);
    assert.deepEqual(counts.rows[0], { aliases: 1, seasons: 1, rosters: 2, players: 1,
      team_stats: 1, basic_stats: 2, advanced_stats: 1 });
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
    const fetchId = await reviewed.recordFetch({ jobKey: job.key, status: 200, ...body }, retry.lease, raw);
    assert.equal((await reviewed.lastSuccessfulFetch(job.key)).id, fetchId);
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
    assert.equal((await app.queries.listGames()).length, 6);
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
      ? { ...entry, body: entry.body.replace('"homeScore":70', '"homeScore":71') } : entry);
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
});
