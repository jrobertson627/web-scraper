import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DISPOSABLE_MARKER_TABLE, assertDisposableDatabase, disposabilityProblem, isLocalHost } from '../scripts/disposable-guard.mjs';

// The scripts that truncate or migrate a database refuse one that is not
// disposable, whatever the confirmation variable says (#121).

test('.env.example does not pre-set either disposable confirmation', () => {
  const template = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  assert.doesNotMatch(template, /^\s*PG_(?:SMOKE|TEST)_CONFIRM\s*=/m);
  // A .env copied from the template therefore satisfies neither guard.
  for (const name of ['PG_SMOKE_CONFIRM', 'PG_TEST_CONFIRM']) {
    const environment = Object.fromEntries(template.split(/\r?\n/).map((line) => /^([A-Z_]+)=(.*)$/.exec(line)).filter(Boolean).map((match) => [match[1], match[2]]));
    assert.notEqual(environment[name], 'disposable');
  }
});

test('only local hosts count as local', () => {
  for (const host of ['localhost', 'LOCALHOST', '127.0.0.1', '::1', '[::1]', 'db.localhost', '/var/run/postgresql']) assert.equal(isLocalHost(host), true, host);
  for (const host of ['dpg-abc123-a', 'dpg-abc123-a.oregon-postgres.render.com', '10.0.0.5', 'localhost.example.com', '', undefined]) assert.equal(isLocalHost(host), false, String(host));
});

test('a hosted database is refused even when it is empty', () => {
  assert.match(disposabilityProblem({ host: 'dpg-abc123-a', database: 'scraper', hasRows: false, hasMarker: false }), /PGHOST is not a local host/);
});

test('a local database with crawl data is refused unless a test run marked it', () => {
  const base = { host: 'localhost', database: 'scraper', hasRows: true };
  assert.match(disposabilityProblem({ ...base, hasMarker: false }), /already holds crawl data/);
  assert.equal(disposabilityProblem({ ...base, hasMarker: true }), null);
  assert.equal(disposabilityProblem({ host: 'localhost', database: 'scraper', hasRows: false, hasMarker: false }), null);
});

test('the override must name the database and is the only way past both checks', () => {
  const hosted = { host: 'dpg-abc123-a', database: 'scraper', hasRows: true, hasMarker: false };
  assert.notEqual(disposabilityProblem({ ...hosted, override: 'yes' }), null);
  assert.notEqual(disposabilityProblem({ ...hosted, override: 'other' }), null);
  assert.equal(disposabilityProblem({ ...hosted, override: 'scraper' }), null);
});

test('messages never echo connection settings', () => {
  const message = disposabilityProblem({ host: 'dpg-secret-host', database: 'secretdb', hasRows: false, hasMarker: false });
  assert.doesNotMatch(message, /dpg-secret-host|secretdb/);
});

function fakeDatabase({ hasJobs = true, hasRows = false, hasMarker = false } = {}) {
  const statements = [];
  const query = async (sql) => {
    statements.push(sql);
    if (/to_regclass/.test(sql)) return [{ has_jobs: hasJobs, has_marker: hasMarker }];
    if (/EXISTS/.test(sql)) return [{ present: hasRows }];
    return [];
  };
  return { query, statements };
}

test('assertDisposableDatabase marks an empty local database and refuses a populated one', async () => {
  const local = { PGHOST: 'localhost', PGDATABASE: 'scraper' };
  const empty = fakeDatabase();
  await assertDisposableDatabase(empty.query, local, { mark: true });
  assert.ok(empty.statements.some((sql) => sql.includes(`CREATE TABLE IF NOT EXISTS ${DISPOSABLE_MARKER_TABLE}`)));

  const marked = fakeDatabase({ hasRows: true, hasMarker: true });
  await assertDisposableDatabase(marked.query, local, { mark: true });
  assert.ok(!marked.statements.some((sql) => sql.startsWith('CREATE')));

  const populated = fakeDatabase({ hasRows: true });
  await assert.rejects(assertDisposableDatabase(populated.query, local, { mark: true }), /already holds crawl data/);
  assert.ok(!populated.statements.some((sql) => sql.startsWith('CREATE')), 'a refused database is not marked');

  await assert.rejects(assertDisposableDatabase(fakeDatabase().query, { PGHOST: 'dpg-abc123-a', PGDATABASE: 'scraper' }), /not a local host/);
});

test('a database that has not been migrated yet is treated as empty', async () => {
  await assertDisposableDatabase(fakeDatabase({ hasJobs: false }).query, { PGHOST: 'localhost', PGDATABASE: 'scraper' });
});
