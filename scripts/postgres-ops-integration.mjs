// PostgreSQL-level checks for the adapter hardening and the API read queries.
// Imported by postgres-integration.mjs so `npm run test:postgres` runs them
// against the same explicitly disposable database; never run on its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { PostgresPersistence, openPostgresPersistence } from '../src/persistence/postgres.mjs';
import { createRawStore } from '../src/persistence/index.mjs';
import { createSourceUrl, canonicalizeSourceUrl, sourceKey } from '../src/contracts/source.mjs';
import { createFixtureApplication } from '../src/application/composition-root.mjs';
import { foundationCorpus } from '../fixtures/foundation-corpus.mjs';
import { summarizeCrawlStatus } from '../src/application/crawl-status.mjs';
import { assertDisposableDatabase } from './disposable-guard.mjs';

if (process.env.PG_TEST_CONFIRM !== 'disposable' || !process.env.PGHOST || !process.env.PGDATABASE || !process.env.PGUSER) {
  throw new Error('PostgreSQL integration tests require an explicitly disposable PG* database');
}

const { Pool } = pg;
// The confirmation above is not enough on its own (#121): refuse a hosted or populated database.
{
  const guard = new pg.Client();
  await guard.connect();
  try { await assertDisposableDatabase(async (sql) => (await guard.query(sql)).rows, process.env, { mark: true }); } finally { await guard.end(); }
}
// .tmp/ is gitignored, so it does not exist on a fresh checkout such as CI.
mkdirSync(join(process.cwd(), '.tmp'), { recursive: true });
const localRoot = mkdtempSync(join(process.cwd(), '.tmp', 'postgres-ops-test-'));

async function reset(pool) {
  const tables = await pool.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`);
  const names = tables.rows.map((row) => `"${row.tablename.replaceAll('"', '""')}"`);
  if (names.length) await pool.query(`TRUNCATE ${names.join(',')} RESTART IDENTITY CASCADE`);
}

function job(path = '/box/one.html', pageType = 'box_score') {
  const sourceUrl = createSourceUrl('fixture-provider', `https://fixture.example${path}`);
  const canonicalPath = canonicalizeSourceUrl(sourceUrl);
  return { key: sourceKey(canonicalPath, pageType), pageType, sourceUrl, canonicalPath };
}

function provenance(source, sourceFetchId) {
  return { providerId: source.sourceUrl.providerId, canonicalPath: source.canonicalPath, sourceUrl: source.sourceUrl,
    sourceFetchId, parserName: source.pageType, parserVersion: '1', parsedAt: new Date().toISOString() };
}

test('an idle client terminated by the server is logged and the adapter keeps serving', async (t) => {
  const pool = new Pool({ max: 2 });
  const admin = new Pool({ max: 1 });
  t.after(async () => { await pool.end(); await admin.end(); });
  const logged = [];
  const persistence = new PostgresPersistence({ pool, onPoolError: (error) => logged.push(error.code) });
  const client = await pool.connect();
  const { rows: [{ pid }] } = await client.query('SELECT pg_backend_pid() AS pid');
  client.release();
  await admin.query('SELECT pg_terminate_backend($1)', [pid]);
  for (let waited = 0; !logged.length && waited < 5000; waited += 50) await delay(50);
  assert.deepEqual(logged, ['57P01']);
  assert.equal(await persistence.getJob('fixture-provider:fixture.example/missing:box_score'), null);
});

test('opened persistence applies the statement timeout to every pooled connection', async () => {
  const persistence = await openPostgresPersistence({ pool: { max: 1 }, onPoolError: () => {} });
  try {
    assert.equal((await persistence.pool.query('SHOW statement_timeout')).rows[0].statement_timeout, '30s');
    await assert.rejects(persistence.transaction((client) => client.query('SET LOCAL statement_timeout = 50; SELECT pg_sleep(1)')),
      (error) => error.code === '57014');
    assert.equal((await persistence.pool.query('SELECT 1 AS ok')).rows[0].ok, 1);
  } finally {
    await persistence.close();
  }
});

test('refetching an unchanged conflicting page does not open a second issue', async (t) => {
  const pool = new Pool({ max: 4 });
  t.after(async () => { await pool.end(); });
  await reset(pool);
  const persistence = new PostgresPersistence({ pool, claimTimeoutMs: 10000 });
  const raw = createRawStore('filesystem', join(localRoot, 'raw-dedup'));
  const index = job('/cbb/schools/', 'school_index');
  await persistence.addJob(index);
  const claimed = await persistence.claimNextJob(new Date(), 'dedup-worker');
  const page = (name) => ({ jobKey: index.key, kind: 'school_index', identity: index.key,
    data: { schools: [{ path: '/school/a', name, to: 2026 }] },
    observations: [{ kind: 'school', parentKey: index.key, rowIndex: 0, eligible: true }] });
  const fetch = async (body) => {
    const stored = await raw.put(Buffer.from(body));
    return persistence.recordFetch({ jobKey: index.key, status: 200, ...stored }, claimed.lease, stored);
  };
  await persistence.commitPage(page('Fixture A'), provenance(index, await fetch('accepted')), claimed.lease);
  assert.equal((await persistence.commitPage(page('Renamed'), provenance(index, await fetch('conflict-1')), claimed.lease)).conflict, true);
  assert.equal((await persistence.commitPage(page('Renamed'), provenance(index, await fetch('conflict-2')), claimed.lease)).conflict, true);
  const open = async () => (await pool.query(`SELECT count(*)::int AS n FROM reconciliation_issues
    WHERE issue_type = 'conflicting_page_reprocess' AND status = 'open'`)).rows[0].n;
  assert.equal(await open(), 1);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM normalized_page_revisions WHERE disposition = 'quarantined'")).rows[0].n, 2);
  await persistence.commitPage(page('Renamed again'), provenance(index, await fetch('conflict-3')), claimed.lease);
  assert.equal(await open(), 2, 'different conflicting content is a separate issue');
});

// Every (node type, relation) in an EXPLAIN (FORMAT JSON) plan.
function planNodes(node, found = []) {
  found.push({ type: node['Node Type'], relation: node['Relation Name'] });
  for (const child of node.Plans ?? []) planNodes(child, found);
  return found;
}

test('API reads are keyed or keyset-paged statements that PostgreSQL can serve from indexes', async (t) => {
  const pool = new Pool({ max: 4 });
  t.after(async () => { await pool.end(); });
  await reset(pool);
  const ingest = new PostgresPersistence({ pool, claimTimeoutMs: 10000 });
  const raw = createRawStore('filesystem', join(localRoot, 'raw-reads'));
  const app = createFixtureApplication({ fixtureEntries: foundationCorpus(), sharedState: { persistence: ingest, rawStore: raw } });
  await app.runWorkerOnce();

  const statements = [];
  const recorded = new Proxy(pool, { get(target, name) {
    if (name !== 'query') return typeof target[name] === 'function' ? target[name].bind(target) : target[name];
    return (sql, params) => { statements.push({ sql, params }); return target.query(sql, params); };
  } });
  const reads = new PostgresPersistence({ pool: recorded });

  const games = [];
  let cursor = null;
  do {
    const page = await reads.listGames({ limit: 4, cursor });
    games.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(games.length, 6);
  assert.equal(new Set(games.map((game) => game.gameKey)).size, 6);
  assert.equal(statements.length, 2, 'two pages, one statement each');
  const pagedGames = statements.at(-1);

  statements.length = 0;
  for (const game of games) assert.deepEqual(await reads.getGame(game.gameKey), game);
  assert.equal(statements.length, games.length, 'one statement per game lookup');
  const gameLookup = statements[0];
  assert.equal(await reads.getGame('fixture-provider:fixture.example/box/missing.html'), null);

  statements.length = 0;
  const health = await reads.health();
  assert.equal(statements.length, 1);
  assert.equal(health.jobStates.parsed, foundationCorpus().length);
  assert.equal(health.sourceFetches, foundationCorpus().length);

  // The fixture clock stamps fetches in January 2026, but the status window
  // trails the database clock, so place the fetches relative to it: one
  // outside the hour, the rest inside.
  await pool.query(`UPDATE source_fetches SET fetched_at = clock_timestamp()
    - CASE WHEN id = (SELECT min(id) FROM source_fetches) THEN interval '2 hours' ELSE interval '1 minute' END`);
  const crawl = await reads.crawlStatus({ windowMs: 3_600_000 });
  assert.equal(crawl.jobs.filter((row) => row.state === 'parsed').reduce((sum, row) => sum + row.count, 0), foundationCorpus().length);
  assert.equal(crawl.fetches.total, foundationCorpus().length);
  assert.equal(crawl.fetches.inWindow, foundationCorpus().length - 1);
  assert.equal(summarizeCrawlStatus(crawl).totals.remaining, 0);

  statements.length = 0;
  const schools = await reads.listSchools({ limit: 2 });
  const seasons = await reads.listSeasons({ limit: 2 });
  assert.equal(schools.items.length, 2);
  assert.ok(schools.nextCursor);
  const moreSeasons = await reads.listSeasons({ limit: 50, cursor: seasons.nextCursor });
  const allSeasons = await reads.listSeasons({ limit: 50 });
  assert.deepEqual([...seasons.items, ...moreSeasons.items], [...allSeasons.items]);

  // With sequential scans disabled the planner still falls back to one when no
  // index can serve the statement, so their absence proves an index path.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL enable_seqscan = off');
    // statements: listSchools, listSeasons, listSeasons after a cursor, listSeasons in full.
    for (const statement of [gameLookup, pagedGames, statements[0], statements[2], statements[3]]) {
      const plan = (await client.query(`EXPLAIN (FORMAT JSON) ${statement.sql}`, statement.params)).rows[0]['QUERY PLAN'][0].Plan;
      const nodes = planNodes(plan);
      for (const table of ['games', 'schools', 'school_seasons', 'normalized_page_revisions']) {
        assert.equal(nodes.some((node) => node.type === 'Seq Scan' && node.relation === table), false,
          `no sequential scan of ${table}: ${JSON.stringify(nodes)}`);
      }
    }
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});

// #117: the raw store identity, and migration 014's rewrite of recorded paths.
test('the first raw store id a database records is kept, and another id does not replace it', async (t) => {
  const pool = new Pool({ max: 2 });
  t.after(async () => { await pool.end(); });
  await reset(pool);
  const persistence = new PostgresPersistence({ pool });
  const first = '11111111-1111-4111-8111-111111111111';
  const second = '22222222-2222-4222-8222-222222222222';
  assert.equal(await persistence.rawStoreId(), null);
  assert.equal(await persistence.claimRawStoreId(first), first);
  assert.equal(await persistence.claimRawStoreId(second), first, 'a later claim gets the recorded id back');
  assert.equal(await persistence.rawStoreId(), first);
  await assert.rejects(pool.query(`INSERT INTO raw_store_identity (singleton, store_id) VALUES (false, $1)`, [second]), /violates check constraint/);
  await assert.rejects(pool.query(`UPDATE raw_store_identity SET store_id = 'not a uuid'`), /violates check constraint/);
  await reset(pool);
});

test('migration 014 rewrites a recorded absolute path to the root-independent reference, once', async (t) => {
  const pool = new Pool({ max: 2 });
  t.after(async () => { await pool.end(); });
  await reset(pool);
  const persistence = new PostgresPersistence({ pool });
  const source = job('/box/legacy.html');
  await persistence.addJob(source);
  const { rows: [row] } = await pool.query(`SELECT id, provider_id, canonical_path FROM crawl_jobs`);
  const checksum = 'cd'.repeat(32);
  const legacy = `file:///var/data/raw/cd/${checksum}`;
  await pool.query(`INSERT INTO source_fetches (job_id,provider_id,canonical_path,http_status,fetched_at,checksum,raw_object_path)
    VALUES ($1,$2,$3,200,clock_timestamp(),$4,$5)`, [row.id, row.provider_id, row.canonical_path, checksum, legacy]);
  await pool.query(`INSERT INTO raw_object_repair (checksum,object_path,state,observed_at,reason) VALUES ($1,$2,'pending',now(),'missing')`, [checksum, legacy]);
  const sql = readFileSync(join(process.cwd(), 'migrations', '014_raw_store_identity.sql'), 'utf8');
  await pool.query(sql);
  const key = `raw:cd/${checksum}`;
  assert.equal((await pool.query('SELECT raw_object_path FROM source_fetches')).rows[0].raw_object_path, key);
  assert.equal((await pool.query('SELECT object_path FROM raw_object_repair')).rows[0].object_path, key);
  await pool.query(sql); // repeat-safe
  assert.equal((await pool.query('SELECT raw_object_path FROM source_fetches')).rows[0].raw_object_path, key);
  // A reference recorded as an absolute path still resolves when read back.
  await pool.query(`UPDATE source_fetches SET raw_object_path = $1`, [legacy]);
  assert.equal((await persistence.lastSuccessfulFetch(source.key)).objectPath, key);
  await reset(pool);
});

// #113, #118: a host pause and the host gate, judged by the database clock.
test('a paused or busy host is reported by the gate, a pause is never shortened, and an orphaned request is released by the gate', async (t) => {
  const pool = new Pool({ max: 2 });
  t.after(async () => { await pool.end(); });
  await reset(pool);
  const persistence = new PostgresPersistence({ pool, claimTimeoutMs: 30_000 });
  const host = 'fixture.example';
  assert.deepEqual(await persistence.hostGate(host), { waitMs: 0, reason: null });

  await persistence.pauseHost(host, new Date(Date.now() + 90_000));
  const paused = await persistence.hostGate(host);
  assert.equal(paused.reason, 'paused');
  assert.ok(paused.waitMs > 60_000 && paused.waitMs <= 90_000, `waitMs ${paused.waitMs}`);
  const before = (await persistence.getRequestSchedule(host)).pausedUntil;
  await persistence.pauseHost(host, new Date(Date.now() + 5_000));
  assert.equal((await persistence.getRequestSchedule(host)).pausedUntil.getTime(), before.getTime(), 'an earlier pause does not shorten a later one');
  await persistence.recordRequestStart(host, new Date());
  assert.equal((await persistence.getRequestSchedule(host)).pausedUntil.getTime(), before.getTime(), 'a request start keeps the pause');
  await pool.query(`UPDATE host_request_schedule SET paused_until = clock_timestamp() - interval '1 second'`);
  assert.deepEqual(await persistence.hostGate(host), { waitMs: 0, reason: null });

  const source = job('/box/gate.html');
  await persistence.addJob(source);
  const claimed = await persistence.claimNextJob(new Date(), 'worker');
  await persistence.acquireRequest(claimed.key, claimed.lease, host);
  assert.deepEqual(await persistence.hostGate(host), { waitMs: 5_000, reason: 'in_flight' });
  // The worker died: its request and its claim are long past the request deadline.
  await pool.query(`UPDATE in_flight_requests SET started_at = clock_timestamp() - interval '1 hour'`);
  await pool.query(`UPDATE crawl_jobs SET claim_expires_at = clock_timestamp() - interval '1 hour'`);
  assert.deepEqual(await persistence.hostGate(host), { waitMs: 0, reason: null }, 'the gate released the orphan');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM in_flight_requests WHERE released_at IS NULL')).rows[0].n, 0);
  await reset(pool);
});

test('a review job summary carries the code of its latest stop', async (t) => {
  const pool = new Pool({ max: 2 });
  t.after(async () => { await pool.end(); });
  await reset(pool);
  const persistence = new PostgresPersistence({ pool, claimTimeoutMs: 30_000 });
  await persistence.addJob(job('/box/coded.html'));
  const claimed = await persistence.claimNextJob(new Date(), 'worker');
  await persistence.transitionJob(claimed.key, 'operator_stop', claimed.lease, { lastError: 'rate limited 5 times', code: 'rate_limit_cap' });
  const page = await persistence.reviewJobs({ states: ['operator_stop'] });
  assert.deepEqual(page.items.map((item) => [item.key, item.code]), [[claimed.key, 'rate_limit_cap']]);
  await reset(pool);
});

// #114: run halts and requeue.
test('a run halt is recorded, blocks a start with the job stops, and needs an authorized release', async (t) => {
  const pool = new Pool({ max: 2 });
  t.after(async () => { await pool.end(); });
  await reset(pool);
  const persistence = new PostgresPersistence({ pool, authorizeOperator: (id) => id === 'ops' });
  assert.deepEqual(await persistence.unreviewedRunHalts(), []);
  const id = await persistence.recordRunHalt({ reason: 'raw_disk_low', detail: 'the raw store has 5 bytes free' });
  assert.equal(id, 'halt-1');
  const halts = await persistence.unreviewedRunHalts();
  assert.deepEqual(halts.map((halt) => [halt.haltId, halt.code, halt.detail, halt.jobKey]), [['halt-1', 'raw_disk_low', 'the raw store has 5 bytes free', null]]);
  assert.deepEqual((await persistence.unreviewedChallenges()).map((entry) => entry.code), ['raw_disk_low'], 'it blocks a start like a challenge stop');
  await assert.rejects(persistence.releaseRunHalt(id, { operatorId: 'intruder', reason: 'x' }), /not authorized/);
  await assert.rejects(persistence.releaseRunHalt('halt-99', { operatorId: 'ops', reason: 'x' }), /does not exist/);
  await assert.rejects(persistence.releaseRunHalt('bad', { operatorId: 'ops', reason: 'x' }), /halt id bad is invalid/);
  await persistence.releaseRunHalt(id, { operatorId: 'ops', reason: 'freed space' });
  await assert.rejects(persistence.releaseRunHalt(id, { operatorId: 'ops', reason: 'again' }), /already released/);
  assert.deepEqual(await persistence.unreviewedChallenges(), []);
  const [row] = (await pool.query('SELECT released_by, release_reason FROM run_halts')).rows;
  assert.deepEqual(row, { released_by: 'ops', release_reason: 'freed space' });
  await reset(pool);
});

test('a permanently_failed page is requeued with a fresh budget, recorded, and shows its failure code', async (t) => {
  const pool = new Pool({ max: 2 });
  t.after(async () => { await pool.end(); });
  await reset(pool);
  const persistence = new PostgresPersistence({ pool, claimTimeoutMs: 30_000, authorizeOperator: (id) => id === 'ops' });
  const source = job('/box/requeue.html');
  await persistence.addJob(source);
  const first = await persistence.claimNextJob(new Date(), 'worker');
  await persistence.transitionJob(first.key, 'retry_wait', first.lease, { nextAllowedAt: new Date(Date.now() - 1_000).toISOString(), charge: 'failure' });
  const second = await persistence.claimNextJob(new Date(), 'worker');
  await persistence.transitionJob(second.key, 'permanently_failed', second.lease, { lastError: 'network error; retry limit reached', code: 'transient_network' });
  const listed = await persistence.reviewJobs({ states: ['permanently_failed'] });
  assert.deepEqual(listed.items.map((item) => [item.key, item.state, item.code]), [[source.key, 'permanently_failed', 'transient_network']]);
  assert.deepEqual((await persistence.reviewJobs()).items, [], 'the default review list does not include it');
  await assert.rejects(persistence.recordOperatorDisposition(source.key, { kind: 'release_retry', operatorId: 'ops', reason: 'x' }), /requires operator_stop/);
  await assert.rejects(persistence.recordOperatorDisposition(source.key, { kind: 'requeue_failed', operatorId: 'intruder', reason: 'x' }), /not authorized/);

  await persistence.recordOperatorDisposition(source.key, { kind: 'requeue_failed', operatorId: 'ops', reason: 'the outage is over' });
  const [after] = (await pool.query('SELECT state, failure_attempts, rate_limit_attempts, claim_recoveries FROM crawl_jobs')).rows;
  assert.deepEqual(after, { state: 'retry_wait', failure_attempts: 0, rate_limit_attempts: 0, claim_recoveries: 0 });
  assert.deepEqual((await pool.query('SELECT disposition, operator_id, reason FROM operator_dispositions')).rows,
    [{ disposition: 'requeue_failed', operator_id: 'ops', reason: 'the outage is over' }]);
  await assert.rejects(persistence.recordOperatorDisposition(source.key, { kind: 'requeue_failed', operatorId: 'ops', reason: 'again' }), /requires permanently_failed/);
  const claimed = await persistence.claimNextJob(new Date(), 'worker');
  assert.equal(claimed.key, source.key, 'the requeued page is claimable again');
  await reset(pool);
});

// #124: the final URL of a fetch that followed redirects.
test('a fetch records the URL it ended at, and it reads back from every fetch read', async (t) => {
  const pool = new Pool({ max: 2 });
  t.after(async () => { await pool.end(); });
  await reset(pool);
  const persistence = new PostgresPersistence({ pool, claimTimeoutMs: 30_000 });
  const source = job('/box/redirected.html');
  await persistence.addJob(source);
  const claimed = await persistence.claimNextJob(new Date(), 'worker');
  const raw = createRawStore('filesystem', join(localRoot, 'raw-final-url'));
  const stored = await raw.put(Buffer.from('a body'));
  const finalUrl = 'https://fixture.example/box/renamed.html';
  const id = await persistence.recordFetch({ jobKey: claimed.key, status: 200, ...stored, finalUrl }, claimed.lease, stored);
  assert.equal((await persistence.lastSuccessfulFetch(claimed.key)).finalUrl, finalUrl);
  assert.equal((await persistence.getSourceFetch(id)).finalUrl, finalUrl);
  const plain = await raw.put(Buffer.from('another body'));
  await persistence.recordFetch({ jobKey: claimed.key, status: 200, ...plain }, claimed.lease, plain);
  assert.equal((await persistence.lastSuccessfulFetch(claimed.key)).finalUrl, undefined, 'a fetch that was not redirected has none');
  await reset(pool);
});
