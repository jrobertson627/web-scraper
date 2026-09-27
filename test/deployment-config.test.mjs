import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const blueprint = readFileSync('render.yaml', 'utf8').replaceAll('\r\n', '\n');

test('the Render blueprint commits no secret values and cannot create a database', () => {
  for (const key of ['PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD', 'USER_AGENT']) {
    assert.match(blueprint, new RegExp(`- key: ${key}\\n\\s+sync: false`), `${key} is entered in the dashboard`);
  }
  assert.doesNotMatch(blueprint, /^databases:/m);
  assert.doesNotMatch(blueprint, /fromDatabase|connectionString|postgres(ql)?:\/\//);
  assert.doesNotMatch(blueprint, /type: (web|pserv)/, 'the unauthenticated read API is not deployed');
  assert.match(blueprint, /type: worker/);
  assert.match(blueprint, /preDeployCommand: npm run migrate/);
  assert.match(blueprint, /RAW_STORE_ROOT\n\s+value: \/var\/data\/raw/);
  assert.match(blueprint, /mountPath: \/var\/data/);
});

test('the environment example documents every runtime variable without real values', () => {
  const example = readFileSync('.env.example', 'utf8');
  for (const name of ['PERSISTENCE', 'PGHOST', 'PGPASSWORD', 'PGSSLMODE', 'PG_STATEMENT_TIMEOUT_MS', 'RAW_STORE_ROOT', 'USER_AGENT', 'HOST']) {
    assert.match(example, new RegExp(`^${name}=`, 'm'), name);
  }
  assert.match(example, /^PGPASSWORD=\s*$/m);
});
