import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const directory = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const files = readdirSync(directory).filter((name) => /^\d{3}_.+\.sql$/.test(name)).sort();

function fail(message, code = 1) {
  console.error(`migrate failed: ${message}`);
  process.exit(code);
}

for (const name of ['PGHOST', 'PGDATABASE', 'PGUSER', 'PGPASSWORD']) {
  if (!process.env[name]) fail(`${name} is required; connection settings are never printed`, 2);
}
if (files.length === 0) fail('no ordered SQL migrations were found', 2);

// Each migration file carries its own BEGIN/COMMIT and is repeat-safe, so a
// file is sent as one simple-protocol query and re-running is harmless.
const client = new pg.Client();
try {
  await client.connect();
} catch (error) {
  fail(`could not connect (${error.code ?? error.message}); check PG* settings, PGSSLMODE, and the IP allow list`);
}
try {
  for (const file of files) {
    try {
      await client.query(readFileSync(join(directory, file), 'utf8'));
    } catch (error) {
      fail(`${file}: ${error.message}`);
    }
    console.log(`applied ${file}`);
  }
  const { rows } = await client.query('SELECT version FROM schema_migrations ORDER BY version');
  const expected = files.map((file) => file.slice(0, -4));
  if (rows.map((row) => row.version).join('|') !== expected.join('|')) {
    fail(`schema_migrations did not match the ${expected.length} ordered files`);
  }
  console.log(`migrate passed: ${expected.length} versions recorded`);
} finally {
  await client.end();
}
