import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  MigrationError, listMigrations, migrationChecksum, runMigrations,
} from '../src/persistence/migrator.mjs';

// #120: the migration runner skips applied migrations, verifies their
// checksums, and runs no DDL when nothing is new.

const migration = (number, body = 'CREATE TABLE IF NOT EXISTS t (id int);') => {
  const version = `${String(number).padStart(3, '0')}_step`;
  const sql = `BEGIN;\n${body}\nINSERT INTO schema_migrations (version) VALUES ('${version}') ON CONFLICT (version) DO NOTHING;\nCOMMIT;\n`;
  return Object.freeze({ version, file: `${version}.sql`, sql, checksum: migrationChecksum(sql) });
};

// A PostgreSQL stand-in that models schema_migrations and records what it was asked.
function fakeDatabase({ recorded = [], hasChecksumColumn = recorded.length > 0, failOn } = {}) {
  const state = {
    versions: new Map(recorded.map(([version, checksum]) => [version, checksum])),
    tableExists: recorded.length > 0,
    hasChecksumColumn,
    statements: [], files: [], settings: [], locked: false, unlocks: 0,
  };
  const client = {
    async query(sql, params = []) {
      const text = sql.trim();
      state.statements.push(text);
      if (/^SET (lock_timeout|statement_timeout) = (\d+)$/.test(text)) { state.settings.push(text); return { rows: [] }; }
      if (text.startsWith('SELECT pg_advisory_lock')) { state.locked = true; return { rows: [] }; }
      if (text.startsWith('SELECT pg_advisory_unlock')) { state.locked = false; state.unlocks += 1; return { rows: [] }; }
      if (text.includes('to_regclass')) return { rows: [{ present: state.tableExists }] };
      if (text.includes('information_schema.columns')) return { rows: state.hasChecksumColumn ? [{ column_name: 'checksum' }] : [] };
      if (text.startsWith('ALTER TABLE schema_migrations ADD COLUMN checksum')) { state.hasChecksumColumn = true; return { rows: [] }; }
      if (text.startsWith('SELECT version, checksum FROM schema_migrations')) {
        return { rows: [...state.versions].map(([version, checksum]) => ({ version, checksum })) };
      }
      if (text.startsWith('UPDATE schema_migrations SET checksum')) {
        const [version, checksum] = params;
        if (!state.versions.has(version)) return { rows: [] };
        state.versions.set(version, checksum);
        return { rows: [{ version }] };
      }
      // Otherwise it is a migration file, which records its own version.
      state.files.push(text);
      if (failOn && text.includes(failOn)) throw Object.assign(new Error('relation "boom" does not exist'), { code: '42P01' });
      state.tableExists = true;
      const version = /VALUES \('([^']+)'\)/.exec(text)?.[1];
      if (version && !text.includes('/* no record */')) state.versions.set(version, state.versions.get(version) ?? null);
      return { rows: [] };
    },
  };
  return { client, state };
}

const migrations = [migration(1), migration(2), migration(3)];

test('a fresh database applies every migration in order and records each checksum', async () => {
  const { client, state } = fakeDatabase();
  const logged = [];
  const result = await runMigrations({ client, migrations, log: (line) => logged.push(line) });
  assert.deepEqual(result, { applied: ['001_step', '002_step', '003_step'], adopted: [], skipped: [], unknown: [] });
  assert.deepEqual(logged, ['applied 001_step.sql', 'applied 002_step.sql', 'applied 003_step.sql']);
  assert.deepEqual(state.files, migrations.map((entry) => entry.sql.trim()));
  assert.deepEqual([...state.versions], migrations.map((entry) => [entry.version, entry.checksum]));
  assert.equal(state.statements.filter((sql) => sql.startsWith('ALTER TABLE')).length, 1, 'the checksum column is added once, after the table exists');
});

test('a database that is up to date skips every migration and runs no DDL', async () => {
  const { client, state } = fakeDatabase({ recorded: migrations.map((entry) => [entry.version, entry.checksum]) });
  const result = await runMigrations({ client, migrations });
  assert.deepEqual(result.applied, []);
  assert.deepEqual(result.skipped, ['001_step', '002_step', '003_step']);
  assert.deepEqual(state.files, [], 'no migration file was sent');
  assert.ok(state.statements.every((sql) => /^(SET|SELECT)\b/.test(sql)), `only SET and SELECT statements ran: ${state.statements.join(' | ')}`);
});

test('only the missing migrations are applied', async () => {
  const { client, state } = fakeDatabase({ recorded: migrations.slice(0, 2).map((entry) => [entry.version, entry.checksum]) });
  const result = await runMigrations({ client, migrations });
  assert.deepEqual([result.applied, result.skipped], [['003_step'], ['001_step', '002_step']]);
  assert.deepEqual(state.files, [migrations[2].sql.trim()]);
});

test('editing an applied migration fails, names the file, and applies nothing', async () => {
  const edited = migration(2, 'CREATE TABLE IF NOT EXISTS t (id int, extra int);');
  const later = migration(4);
  const { client, state } = fakeDatabase({ recorded: migrations.map((entry) => [entry.version, entry.checksum]) });
  await assert.rejects(runMigrations({ client, migrations: [migrations[0], { ...edited, version: '002_step', file: '002_step.sql' }, migrations[2], later] }),
    (error) => error instanceof MigrationError && /002_step\.sql changed since it was applied/.test(error.message) && /new migration file/.test(error.message));
  assert.deepEqual(state.files, [], 'the new migration was not applied either');
  assert.equal(state.locked, false, 'the lock was released');
});

test('several edited files are all named', async () => {
  const one = { ...migration(1, 'SELECT 1;'), version: '001_step', file: '001_step.sql' };
  const three = { ...migration(3, 'SELECT 3;'), version: '003_step', file: '003_step.sql' };
  const { client } = fakeDatabase({ recorded: migrations.map((entry) => [entry.version, entry.checksum]) });
  await assert.rejects(runMigrations({ client, migrations: [one, migrations[1], three] }), /001_step\.sql, 003_step\.sql changed since they were applied/);
});

test('versions recorded before checksums existed are adopted, not run again', async () => {
  const { client, state } = fakeDatabase({ recorded: migrations.map((entry) => [entry.version, null]), hasChecksumColumn: false });
  const result = await runMigrations({ client, migrations });
  assert.deepEqual([result.applied, result.adopted], [[], ['001_step', '002_step', '003_step']]);
  assert.deepEqual(state.files, []);
  assert.ok(state.statements.some((sql) => sql.startsWith('ALTER TABLE schema_migrations ADD COLUMN checksum')), 'the column is added to an older table');
  assert.deepEqual([...state.versions].map(([, checksum]) => checksum), migrations.map((entry) => entry.checksum));
  // Once adopted, a later edit is caught.
  const again = fakeDatabase({ recorded: [...state.versions] });
  await assert.rejects(runMigrations({ client: again.client, migrations: [{ ...migration(1, 'SELECT 9;'), version: '001_step', file: '001_step.sql' }] }), /001_step\.sql changed/);
});

test('a new migration that sorts before an applied one is refused', async () => {
  const { client, state } = fakeDatabase({ recorded: [migrations[0], migrations[2]].map((entry) => [entry.version, entry.checksum]) });
  await assert.rejects(runMigrations({ client, migrations }), /002_step\.sql sorts before 003_step, which is already applied/);
  assert.deepEqual(state.files, []);
});

test('recorded versions with no file are reported, not fatal, so code can roll back', async () => {
  const { client } = fakeDatabase({ recorded: [...migrations, migration(4)].map((entry) => [entry.version, entry.checksum]) });
  const result = await runMigrations({ client, migrations });
  assert.deepEqual([result.applied, result.unknown], [[], ['004_step']]);
});

test('a migration that does not record its own version is an error', async () => {
  const silent = migration(1, '/* no record */ SELECT 1;');
  const { client } = fakeDatabase();
  await assert.rejects(runMigrations({ client, migrations: [silent] }), /001_step\.sql ran but did not record version 001_step/);
});

test('a failing migration names its file and stops the run', async () => {
  const { client, state } = fakeDatabase({ failOn: 'boom' });
  const broken = migration(2, 'CREATE TABLE boom (id int);');
  await assert.rejects(runMigrations({ client, migrations: [migrations[0], broken, migrations[2]] }), /002_step\.sql: relation "boom" does not exist/);
  assert.deepEqual([...state.versions.keys()], ['001_step']);
  assert.equal(state.unlocks, 1);
});

test('timeouts are set before the lock is taken, and the lock is released afterwards', async () => {
  const { client, state } = fakeDatabase();
  await runMigrations({ client, migrations, lockTimeoutMs: 2_500, statementTimeoutMs: 90_000 });
  assert.deepEqual(state.settings, ['SET lock_timeout = 2500', 'SET statement_timeout = 90000']);
  assert.deepEqual(state.statements.slice(0, 3).map((sql) => sql.split('(')[0].trim()), ['SET lock_timeout = 2500', 'SET statement_timeout = 90000', 'SELECT pg_advisory_lock']);
  assert.equal(state.locked, false);
  assert.equal(state.unlocks, 1);
  await assert.rejects(runMigrations({ client: fakeDatabase().client, migrations, lockTimeoutMs: 0 }), /lock timeout must be a positive integer/);
  await assert.rejects(runMigrations({ client: fakeDatabase().client, migrations: [] }), /no ordered SQL migrations/);
});

test('a blocked lock fails the run without applying anything', async () => {
  const { client, state } = fakeDatabase();
  const blocked = { query: async (sql, params) => (sql.startsWith('SELECT pg_advisory_lock') ? Promise.reject(Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' })) : client.query(sql, params)) };
  await assert.rejects(runMigrations({ client: blocked, migrations }), /could not take the migration lock \(55P03\)/);
  assert.deepEqual(state.files, []);
});

test('checksums ignore line endings and a byte-order mark, and follow content', () => {
  assert.equal(migrationChecksum('a\r\nb\r\n'), migrationChecksum('a\nb\n'));
  assert.equal(migrationChecksum('﻿a\nb\n'), migrationChecksum('a\nb\n'));
  assert.notEqual(migrationChecksum('a\nb\n'), migrationChecksum('a\nb \n'));
  assert.match(migrationChecksum('x'), /^[0-9a-f]{64}$/);
});

test('the real migrations list in order with distinct checksums', () => {
  const real = listMigrations(join(process.cwd(), 'migrations'));
  assert.ok(real.length >= 13);
  assert.deepEqual(real.map((entry) => entry.version), [...real.map((entry) => entry.version)].sort());
  assert.equal(real[0].version, '001_foundation');
  assert.equal(new Set(real.map((entry) => entry.checksum)).size, real.length);
  for (const entry of real) assert.equal(entry.file, `${entry.version}.sql`);
});
