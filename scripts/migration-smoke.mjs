import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertDisposableDatabase } from './disposable-guard.mjs';

const directory = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const files = readdirSync(directory).filter((name) => /^\d{3}_.+\.sql$/.test(name)).sort();

function fail(message, code = 1) {
  console.error(`migration smoke failed: ${message}`);
  process.exit(code);
}

if (process.env.PG_SMOKE_CONFIRM !== 'disposable') {
  fail('set PG_SMOKE_CONFIRM=disposable only for a disposable PostgreSQL database', 2);
}
for (const name of ['PGHOST', 'PGDATABASE', 'PGUSER']) {
  if (!process.env[name]) fail(`${name} is required; connection settings are never printed`, 2);
}
if (files.length === 0) fail('no ordered SQL migrations were found', 2);

function psql(args) {
  const result = spawnSync('psql', ['-X', '-w', '-v', 'ON_ERROR_STOP=1', ...args], {
    encoding: 'utf8', env: process.env, windowsHide: true,
  });
  if (result.error) fail(`psql is unavailable: ${result.error.code ?? result.error.message}`);
  if (result.status !== 0) fail(`psql exited ${result.status}; verify the disposable connection and SQL migrations`);
  return result.stdout.trim();
}

// The confirmation above is not enough on its own (#121): refuse a hosted or populated database.
try {
  await assertDisposableDatabase((sql) => JSON.parse(psql(['-Atc', `SELECT coalesce(json_agg(t), '[]'::json) FROM (${sql}) t`])), process.env);
} catch (error) {
  fail(error.message, 2);
}

for (let pass = 1; pass <= 2; pass += 1) {
  for (const file of files) psql(['-f', join(directory, file)]);
  console.log(`migration pass ${pass} completed (${files.length} files)`);
}

const versions = psql(['-Atc', 'SELECT version FROM schema_migrations ORDER BY version']);
const expected = files.map((file) => file.slice(0, -4));
if (versions.split(/\r?\n/).join('|') !== expected.join('|')) {
  fail(`schema_migrations did not match the ${expected.length} ordered files`);
}
console.log(`migration smoke passed: ${expected.length} versions, repeat-safe`);
