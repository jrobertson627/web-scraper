// PostgreSQL-level checks for the adapter hardening and the API read queries.
// Imported by postgres-integration.mjs so `npm run test:postgres` runs them
// against the same explicitly disposable database; never run on its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { PostgresPersistence, openPostgresPersistence } from '../src/persistence/postgres.mjs';
import { createRawStore } from '../src/persistence/index.mjs';
import { createSourceUrl, canonicalizeSourceUrl, sourceKey } from '../src/contracts/source.mjs';
import { createFixtureApplication } from '../src/application/composition-root.mjs';
import { foundationCorpus } from '../fixtures/foundation-corpus.mjs';
import { summarizeCrawlStatus } from '../src/application/crawl-status.mjs';

if (process.env.PG_TEST_CONFIRM !== 'disposable' || !process.env.PGHOST || !process.env.PGDATABASE || !process.env.PGUSER) {
  throw new Error('PostgreSQL integration tests require an explicitly disposable PG* database');
}

const { Pool } = pg;
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
  const fetch = async (body) => persistence.recordFetch({ jobKey: index.key, status: 200, ...raw.put(Buffer.from(body)) }, claimed.lease, raw);
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
