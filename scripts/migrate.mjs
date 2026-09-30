import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  DEFAULT_LOCK_TIMEOUT_MS, DEFAULT_STATEMENT_TIMEOUT_MS, MigrationError, listMigrations, runMigrations,
} from '../src/persistence/migrator.mjs';

// `npm run migrate`, the pre-deploy command (#120): applies the migrations that
// are not yet recorded, verifies the checksums of the ones that are, and runs no
// DDL when nothing is new. See src/persistence/migrator.mjs.

const directory = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

function fail(message, code = 1) {
  console.error(`migrate failed: ${message}`);
  process.exit(code);
}

function milliseconds(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  if (!/^\d{1,9}$/.test(value) || Number(value) < 1) fail(`${name} must be a positive whole number of milliseconds`, 2);
  return Number(value);
}

for (const name of ['PGHOST', 'PGDATABASE', 'PGUSER', 'PGPASSWORD']) {
  if (!process.env[name]) fail(`${name} is required; connection settings are never printed`, 2);
}
const migrations = listMigrations(directory);
if (migrations.length === 0) fail('no ordered SQL migrations were found', 2);
const lockTimeoutMs = milliseconds('MIGRATE_LOCK_TIMEOUT_MS', DEFAULT_LOCK_TIMEOUT_MS);
const statementTimeoutMs = milliseconds('MIGRATE_STATEMENT_TIMEOUT_MS', DEFAULT_STATEMENT_TIMEOUT_MS);

const client = new pg.Client();
try {
  await client.connect();
} catch (error) {
  fail(`could not connect (${error.code ?? error.message}); check PG* settings, PGSSLMODE, and the IP allow list`);
}
try {
  const result = await runMigrations({ client, migrations, log: (line) => console.log(line), lockTimeoutMs, statementTimeoutMs });
  if (result.unknown.length) console.warn(`the database records ${result.unknown.length} version(s) with no file here (${result.unknown.join(', ')}); this checkout is older than the database`);
  console.log(`skipped ${result.skipped.length} already applied`);
  console.log(`migrate passed: ${migrations.length} versions recorded (${result.applied.length} applied now)`);
} catch (error) {
  if (error instanceof MigrationError) fail(error.message);
  throw error;
} finally {
  await client.end();
}
