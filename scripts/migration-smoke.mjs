import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
