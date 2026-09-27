import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PostgresPersistence, guardPool } from '../src/persistence/postgres.mjs';
import { InMemoryPersistence } from '../src/persistence/index.mjs';
import { persistenceSettings } from '../src/config/persistence.mjs';
import { createJob, createNormalizedPage } from '../src/contracts/boundaries.mjs';
import { createProvenance } from '../src/contracts/provenance.mjs';
import { canonicalizeSourceUrl, createSourceUrl } from '../src/contracts/source.mjs';

const PG_ENV = { PERSISTENCE: 'postgres', PGHOST: 'db.internal', PGDATABASE: 'scraper', PGUSER: 'scraper', PGPASSWORD: 'TOP_SECRET' };

function fakePool({ rollbackFails = false } = {}) {
  const pool = new EventEmitter();
  pool.released = [];
  pool.statements = [];
  pool.connect = async () => ({
    query: async (sql) => {
      pool.statements.push(sql);
      if (sql === 'ROLLBACK' && rollbackFails) throw Object.assign(new Error('connection terminated'), { code: '57P01' });
      return { rows: [], rowCount: 0 };
    },
    release: (error) => { pool.released.push(error); },
  });
  return pool;
}

test('an idle pooled client error is logged by code and does not crash the process', () => {
  const pool = fakePool();
  const logged = [];
  const persistence = new PostgresPersistence({ pool, onPoolError: (error) => logged.push(error.code) });
  assert.equal(persistence.pool.listenerCount('error'), 1);
  // Without a listener, EventEmitter would throw this error out of emit().
  pool.emit('error', Object.assign(new Error('terminating connection due to administrator command on db.internal'), { code: '57P01' }));
  assert.deepEqual(logged, ['57P01']);
  guardPool(pool, () => {});
  new PostgresPersistence({ pool });
  assert.equal(pool.listenerCount('error'), 1, 'a shared pool is guarded once');
  const throwing = guardPool(fakePool(), () => { throw new Error('logger failed'); });
  assert.doesNotThrow(() => throwing.emit('error', new Error('idle client lost')));
});

test('the default pool error log names only the error code, never connection values', (t) => {
  const lines = [];
  t.mock.method(console, 'error', (line) => lines.push(line));
  const pool = guardPool(fakePool());
  pool.emit('error', Object.assign(new Error('password authentication failed for user "scraper" host db.internal'), { code: '28P01' }));
  assert.equal(lines.length, 1);
  assert.deepEqual(Object.keys(JSON.parse(lines[0])).sort(), ['at', 'code', 'event']);
  assert.equal(JSON.parse(lines[0]).code, '28P01');
  assert.doesNotMatch(lines[0], /scraper|db\.internal|password/);
});

test('a transaction whose ROLLBACK fails destroys its client instead of returning it to the pool', async () => {
  const broken = fakePool({ rollbackFails: true });
  const persistence = new PostgresPersistence({ pool: broken, onPoolError: () => {} });
  await assert.rejects(persistence.transaction(async () => { throw new Error('write failed'); }), /write failed/);
  assert.equal(broken.released.length, 1);
  assert.equal(broken.released[0]?.code, '57P01');

  const healthy = fakePool();
  const clean = new PostgresPersistence({ pool: healthy, onPoolError: () => {} });
  await assert.rejects(clean.transaction(async () => { throw new Error('write failed'); }), /write failed/);
  assert.equal(await clean.transaction(async () => 'ok'), 'ok');
  assert.deepEqual(healthy.released, [undefined, undefined]);
  assert.deepEqual(healthy.statements, ['BEGIN', 'ROLLBACK', 'BEGIN', 'COMMIT']);
});

test('postgres settings carry a statement timeout that can be tuned but not disabled', () => {
  assert.equal(persistenceSettings(PG_ENV).pool.statement_timeout, 30000);
  assert.equal(persistenceSettings({ ...PG_ENV, PG_STATEMENT_TIMEOUT_MS: '5000' }).pool.statement_timeout, 5000);
  for (const value of ['0', '-1', 'abc', '1.5']) {
    assert.throws(() => persistenceSettings({ ...PG_ENV, PG_STATEMENT_TIMEOUT_MS: value }),
      (error) => /PG_STATEMENT_TIMEOUT_MS is invalid/.test(error.message) && !error.message.includes(`${value}.`));
  }
  assert.throws(() => persistenceSettings({ ...PG_ENV, PGPORT: 'secret-looking-port' }),
    (error) => /PGPORT is invalid/.test(error.message) && !error.message.includes('secret-looking-port'));
});

test('refetching an unchanged conflicting page keeps a single open reconciliation issue', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  const persistence = new InMemoryPersistence(() => now);
  const sourceUrl = createSourceUrl('provider', 'https://allowed.example/box/one');
  const canonicalPath = canonicalizeSourceUrl(sourceUrl);
  persistence.addJob(createJob({ key: 'box', pageType: 'box_score', sourceUrl, canonicalPath }));
  const claimed = persistence.claimNextJob(now, 'worker');
  const page = (score) => createNormalizedPage({ jobKey: 'box', kind: 'game', identity: 'game', data: { score } });
  const provenance = (sourceFetchId) => createProvenance({ providerId: 'provider', canonicalPath, sourceUrl, sourceFetchId,
    parserName: 'box_score', parserVersion: '1', parsedAt: now.toISOString() });

  persistence.commitPage(page(70), provenance('fetch-1'), claimed.lease);
  persistence.commitPage(page(71), provenance('fetch-2'), claimed.lease);
  persistence.commitPage(page(71), provenance('fetch-3'), claimed.lease);
  assert.equal(persistence.reconciliationIssues.length, 1);
  assert.equal(persistence.reconciliationIssues[0].details.current.provenance.sourceFetchId, 'fetch-2');
  persistence.commitPage(page(72), provenance('fetch-4'), claimed.lease);
  assert.equal(persistence.reconciliationIssues.length, 2, 'different conflicting content is a new issue');
  assert.equal(persistence.pages.get('game').data.score, 70);
});

test('the PostgreSQL open-issue index deduplicates on a stable key, not on the details payload', () => {
  const migration = readFileSync(join(process.cwd(), 'migrations', '010_reconciliation_issue_dedup.sql'), 'utf8');
  assert.match(migration, /DROP INDEX IF EXISTS one_open_reconciliation_fact;/);
  assert.match(migration, /ON reconciliation_issues \(issue_type, record_key, dedup_key\) WHERE status = 'open'/);
  assert.match(migration, /ALTER COLUMN dedup_key SET NOT NULL/);
  const writer = readFileSync(join(process.cwd(), 'src', 'persistence', 'postgres-domain.mjs'), 'utf8');
  const inserts = writer.match(/INSERT INTO reconciliation_issues \([^)]*\)/g);
  assert.ok(inserts.length >= 2);
  for (const insert of inserts) assert.match(insert, /dedup_key/);
});
