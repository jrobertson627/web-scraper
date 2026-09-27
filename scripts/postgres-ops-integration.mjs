// PostgreSQL-level checks for the adapter hardening and the API read queries.
// Imported by postgres-integration.mjs so `npm run test:postgres` runs them
// against the same explicitly disposable database; never run on its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { PostgresPersistence, openPostgresPersistence } from '../src/persistence/postgres.mjs';
import { createRawStore } from '../src/persistence/index.mjs';
import { createSourceUrl, canonicalizeSourceUrl, sourceKey } from '../src/contracts/source.mjs';

if (process.env.PG_TEST_CONFIRM !== 'disposable' || !process.env.PGHOST || !process.env.PGDATABASE || !process.env.PGUSER) {
  throw new Error('PostgreSQL integration tests require an explicitly disposable PG* database');
}

const { Pool } = pg;
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
