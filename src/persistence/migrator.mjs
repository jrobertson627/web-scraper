import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// The migration runner behind `npm run migrate` (#120). It takes a connected
// client, so the same code runs against PostgreSQL and against a test double.
//
// A deploy runs every migration file that is not yet in schema_migrations, in
// order, and nothing else: a database that is up to date executes no DDL, so
// it takes no ACCESS EXCLUSIVE lock while the previous worker may still be
// running. Each applied file's checksum is recorded, and a file whose content
// no longer matches its recorded checksum stops the deploy before anything is
// applied, naming the file: an applied migration is history, and a change to it
// is a new file. See "Migration rules" in POSTGRES_SCHEMA.md.
//
// Each file carries its own BEGIN/COMMIT and records its own version, and is
// repeat-safe (scripts/migration-smoke.mjs applies each twice), so a run that
// died after a file committed but before its checksum was recorded is safe to
// repeat: the version is present, so the file is adopted, not run again.

const LOCK_NAME = 'web-scraper-migrations';
export const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
export const DEFAULT_STATEMENT_TIMEOUT_MS = 120_000;

export class MigrationError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'MigrationError';
  }
}

// The SHA-256 of a migration's text, with line endings normalised so a checkout
// with CRLF (a Windows working copy) and one with LF agree, and any BOM ignored.
export function migrationChecksum(text) {
  return createHash('sha256').update(String(text).replace(/^﻿/, '').replaceAll('\r\n', '\n')).digest('hex');
}

// The ordered migration files in a directory: { version, file, sql, checksum }.
export function listMigrations(directory) {
  return readdirSync(directory).filter((name) => /^\d{3}_.+\.sql$/.test(name)).sort().map((file) => {
    const sql = readFileSync(join(directory, file), 'utf8');
    return Object.freeze({ version: file.slice(0, -4), file, sql, checksum: migrationChecksum(sql) });
  });
}

function positiveInteger(name, value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new MigrationError(`${name} must be a positive integer number of milliseconds`);
  return value;
}

// Applies the migrations that are missing and returns what it did:
// { applied, adopted, skipped, unknown } as lists of versions. `adopted` are
// versions recorded before checksums existed (or by a run that stopped before
// recording one); they get their current checksum without being run again.
// `unknown` are recorded versions with no file here, such as a newer database
// under an older checkout; they are reported, not treated as an error, so a
// rollback of the code can still deploy.
export async function runMigrations({
  client, migrations, log = () => {}, lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS, statementTimeoutMs = DEFAULT_STATEMENT_TIMEOUT_MS,
}) {
  if (!migrations?.length) throw new MigrationError('no ordered SQL migrations were found');
  // A blocked lock must fail the deploy quickly, not queue every other query behind it.
  await client.query(`SET lock_timeout = ${positiveInteger('lock timeout', lockTimeoutMs)}`);
  await client.query(`SET statement_timeout = ${positiveInteger('statement timeout', statementTimeoutMs)}`);
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [LOCK_NAME]);
  } catch (error) {
    throw new MigrationError(`could not take the migration lock (${error.code ?? 'failed'}): another migration may be running`, { cause: error });
  }
  try {
    return await apply({ client, migrations, log });
  } finally {
    try { await client.query('SELECT pg_advisory_unlock(hashtext($1))', [LOCK_NAME]); } catch { /* the session ending releases it */ }
  }
}

async function apply({ client, migrations, log }) {
  const present = (await client.query(`SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present`)).rows[0].present;
  let hasChecksum = false;
  const ensureChecksumColumn = async () => {
    if (hasChecksum) return;
    const column = await client.query(`SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'schema_migrations' AND column_name = 'checksum'`);
    if (!column.rows.length) await client.query('ALTER TABLE schema_migrations ADD COLUMN checksum TEXT');
    hasChecksum = true;
  };
  let recorded = new Map();
  if (present) {
    await ensureChecksumColumn();
    recorded = new Map((await client.query('SELECT version, checksum FROM schema_migrations')).rows.map((row) => [row.version, row.checksum]));
  }

  // Check every applied file before applying anything.
  const changed = migrations.filter((migration) => recorded.get(migration.version) && recorded.get(migration.version) !== migration.checksum);
  if (changed.length) {
    throw new MigrationError(`${changed.map((migration) => migration.file).join(', ')} changed since ${changed.length === 1 ? 'it was' : 'they were'} applied. An applied migration must not be edited: revert the change and put it in a new migration file`);
  }
  const newest = migrations.filter((migration) => recorded.has(migration.version)).at(-1)?.version;
  const late = migrations.filter((migration) => !recorded.has(migration.version) && newest && migration.version < newest);
  if (late.length) {
    throw new MigrationError(`${late.map((migration) => migration.file).join(', ')} sorts before ${newest}, which is already applied. Give a new migration the next number`);
  }

  const result = { applied: [], adopted: [], skipped: [], unknown: [] };
  for (const migration of migrations) {
    if (recorded.has(migration.version)) {
      if (recorded.get(migration.version) === null) {
        await client.query('UPDATE schema_migrations SET checksum = $2 WHERE version = $1', [migration.version, migration.checksum]);
        result.adopted.push(migration.version);
        log(`adopted ${migration.file}`);
      } else result.skipped.push(migration.version);
      continue;
    }
    try {
      await client.query(migration.sql);
    } catch (error) {
      throw new MigrationError(`${migration.file}: ${error.message}`, { cause: error });
    }
    await ensureChecksumColumn();
    const stamped = await client.query('UPDATE schema_migrations SET checksum = $2 WHERE version = $1 RETURNING version', [migration.version, migration.checksum]);
    if (!stamped.rows.length) throw new MigrationError(`${migration.file} ran but did not record version ${migration.version} in schema_migrations`);
    recorded.set(migration.version, migration.checksum);
    result.applied.push(migration.version);
    log(`applied ${migration.file}`);
  }
  const known = new Set(migrations.map((migration) => migration.version));
  result.unknown = [...recorded.keys()].filter((version) => !known.has(version)).sort();
  return result;
}
