// PostgreSQL-level checks for the migration runner (#120). Imported by
// postgres-integration.mjs so `npm run test:postgres` runs them against the same
// explicitly disposable database; never run on its own.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { listMigrations, migrationChecksum, runMigrations } from '../src/persistence/migrator.mjs';
import { assertDisposableDatabase } from './disposable-guard.mjs';

if (process.env.PG_TEST_CONFIRM !== 'disposable' || !process.env.PGHOST || !process.env.PGDATABASE || !process.env.PGUSER) {
  throw new Error('PostgreSQL integration tests require an explicitly disposable PG* database');
}

const client = new pg.Client();
await client.connect();
await assertDisposableDatabase(async (sql) => (await client.query(sql)).rows, process.env, { mark: true });
after(async () => { await client.end(); });

const migrations = listMigrations(join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations'));
const probe = (() => {
  const version = '999_migrator_probe';
  const sql = `BEGIN;\nCREATE TABLE IF NOT EXISTS migrator_probe (id int);\nINSERT INTO schema_migrations (version) VALUES ('${version}') ON CONFLICT (version) DO NOTHING;\nCOMMIT;\n`;
  return Object.freeze({ version, file: `${version}.sql`, sql, checksum: migrationChecksum(sql) });
})();

// A client that records the statements it is asked to run.
const recording = () => {
  const statements = [];
  return { statements, query: (sql, params) => { statements.push(String(sql).trim()); return client.query(sql, params); } };
};

async function cleanUp() {
  await client.query('DROP TABLE IF EXISTS migrator_probe');
  await client.query(`DELETE FROM schema_migrations WHERE version = '${probe.version}'`);
}

test('every migration is applied and recorded with its checksum', async () => {
  await runMigrations({ client, migrations });
  const { rows } = await client.query('SELECT version, checksum FROM schema_migrations ORDER BY version');
  assert.deepEqual(rows, migrations.map((entry) => ({ version: entry.version, checksum: entry.checksum })));
});

test('a database that is up to date skips every migration and runs no DDL', async () => {
  const spy = recording();
  const result = await runMigrations({ client: spy, migrations });
  assert.deepEqual(result.applied, []);
  assert.equal(result.skipped.length, migrations.length);
  assert.ok(spy.statements.every((sql) => /^(SET|SELECT)\b/.test(sql)), `only SET and SELECT ran: ${spy.statements.join(' | ')}`);
  assert.ok(!spy.statements.some((sql) => migrations.some((entry) => entry.sql.trim() === sql)), 'no migration file was sent');
});

test('editing an applied migration fails and names the file', async () => {
  const edited = migrations.map((entry) => (entry.version === '002_job_lifecycle'
    ? { ...entry, sql: `${entry.sql}\n-- edited`, checksum: migrationChecksum(`${entry.sql}\n-- edited`) } : entry));
  await assert.rejects(runMigrations({ client, migrations: edited }), /002_job_lifecycle\.sql changed since it was applied/);
});

test('a new migration is applied once, recorded with its checksum, and skipped afterwards', async () => {
  try {
    const first = await runMigrations({ client, migrations: [...migrations, probe] });
    assert.deepEqual(first.applied, [probe.version]);
    const { rows } = await client.query('SELECT checksum FROM schema_migrations WHERE version = $1', [probe.version]);
    assert.equal(rows[0].checksum, probe.checksum);
    const second = await runMigrations({ client, migrations: [...migrations, probe] });
    assert.deepEqual(second.applied, []);
    assert.equal(second.skipped.length, migrations.length + 1);
  } finally { await cleanUp(); }
});

test('a version recorded without a checksum is adopted, not run again', async () => {
  try {
    await client.query(`INSERT INTO schema_migrations (version) VALUES ('${probe.version}')`);
    const spy = recording();
    const result = await runMigrations({ client: spy, migrations: [...migrations, probe] });
    assert.deepEqual([result.applied, result.adopted], [[], [probe.version]]);
    assert.ok(!spy.statements.includes(probe.sql.trim()), 'the file was not run');
  } finally { await cleanUp(); }
});

test('the session lock is released after a run', async () => {
  await runMigrations({ client, migrations });
  const { rows } = await client.query(`SELECT count(*)::int AS held FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()`);
  assert.equal(rows[0].held, 0);
});
