import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { runCli, EXIT_CODES } from '../src/application/cli.mjs';
import { persistenceSettings } from '../src/config/persistence.mjs';
import { contractFingerprint } from '../src/config/data-contract.mjs';
import { createQueryModels } from '../src/contracts/boundaries.mjs';
import { assertSchemaCurrent, expectedMigrationVersions } from '../src/persistence/postgres.mjs';

const PG_ENV = { PERSISTENCE: 'postgres', PGHOST: 'db.internal', PGDATABASE: 'scraper', PGUSER: 'scraper', PGPASSWORD: 'TOP_SECRET' };

async function availablePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function fakePersistence(models = {}) {
  return {
    closed: 0,
    async queryModels() { return createQueryModels(models); },
    async close() { this.closed += 1; },
  };
}

function workerEnv(extra) {
  const dataContract = { providerId: 'provider', version: 'v1', retainedFields: ['school'], attribution: 'Provider', sourceLinksRequired: true, redistribution: 'private', retention: 'indefinite' };
  const authorization = { providerId: 'provider', status: 'active', uses: ['crawl'], evidenceRef: 'private-record', contractVersion: 'v1', contractFingerprint: contractFingerprint(dataContract),
    scope: { allowedHosts: ['provider.example'], eligibilityPredicate: 'To == 2026', targetEndingYears: [2022, 2023, 2024, 2025, 2026] } };
  return { USER_AGENT: 'test (+ops@example.com)', RAW_STORE_ROOT: process.cwd(), AUTHORIZATION_JSON: JSON.stringify(authorization), DATA_CONTRACT_JSON: JSON.stringify(dataContract), ...extra };
}

test('persistence defaults to memory and postgres is opt-in with explicit connection values', () => {
  assert.equal(persistenceSettings({ PGHOST: 'db.internal' }).kind, 'memory');
  const settings = persistenceSettings({ ...PG_ENV, PGPORT: '6543', PGSSLMODE: 'require' });
  assert.deepEqual({ ...settings.pool }, { host: 'db.internal', port: 6543, database: 'scraper', user: 'scraper', password: 'TOP_SECRET', ssl: true });
  assert.deepEqual(persistenceSettings({ ...PG_ENV, PGSSLMODE: 'no-verify' }).pool.ssl, { rejectUnauthorized: false });
  assert.equal(persistenceSettings({ ...PG_ENV, PGSSLMODE: 'disable' }).pool.ssl, false);
  assert.throws(() => persistenceSettings({ PERSISTENCE: 'sqlite' }), /PERSISTENCE is invalid/);
  assert.throws(() => persistenceSettings({ ...PG_ENV, PGHOST: '' }), /PGHOST is missing/);
  assert.throws(() => persistenceSettings({ ...PG_ENV, PGPORT: 'abc' }), /PGPORT is invalid/);
  assert.throws(() => persistenceSettings({ ...PG_ENV, PGSSLMODE: 'always' }), /PGSSLMODE is invalid/);
});

test('schema check requires every ordered migration and never reports connection values', async () => {
  const expected = expectedMigrationVersions();
  assert.ok(expected.length > 0);
  const pool = (versions) => ({ query: async () => ({ rows: versions.map((version) => ({ version })) }) });
  await assertSchemaCurrent(pool(expected));
  await assert.rejects(assertSchemaCurrent(pool(expected.slice(0, -1))), new RegExp(`schema is behind.*${expected.at(-1)}`));
  const failing = (error) => ({ query: async () => { throw error; } });
  await assert.rejects(assertSchemaCurrent(failing(Object.assign(new Error('relation does not exist'), { code: '42P01' }))), /schema is missing/);
  await assert.rejects(assertSchemaCurrent(failing(Object.assign(new Error('password authentication failed for user "scraper" host db.internal'), { code: '28P01' }))),
    (error) => /unavailable \(28P01\)/.test(error.message) && !/scraper|db\.internal/.test(error.message));
});

test('API in postgres mode serves the durable store without running the fixture crawl', async () => {
  const port = await availablePort();
  const persistence = fakePersistence({ schools: [{ path: '/school/x', name: 'Durable', to: 2026, eligible: true, provenance: {} }], health: { jobStates: { parsed: 3 } } });
  let opened;
  const output = [];
  const running = await runCli({
    mode: 'api', env: { ...PG_ENV, PORT: String(port) }, stdout: (message) => output.push(message),
    openPostgres: async (settings) => { opened = settings; return persistence; },
  });
  try {
    assert.equal(running.exitCode, EXIT_CODES.success);
    assert.equal(opened.pool.host, 'db.internal');
    assert.equal(running.app, undefined);
    const [schools, health] = await Promise.all([
      fetch(`http://127.0.0.1:${port}/schools`).then((response) => response.json()),
      fetch(`http://127.0.0.1:${port}/health`).then((response) => response.json()),
    ]);
    assert.deepEqual(schools.map((school) => school.name), ['Durable']);
    assert.equal(health.jobStates.parsed, 3);
    assert.equal(running.lifecycle.state, 'running');
    assert.match(output[0], /API ready/);
  } finally {
    await running.close();
  }
  assert.equal(persistence.closed, 1);
  assert.equal(running.lifecycle.state, 'stopped');
});

test('API rejects invalid persistence settings before opening anything', async () => {
  const errors = [];
  let opened = false;
  const result = await runCli({
    mode: 'api', env: { ...PG_ENV, PGHOST: '' }, stderr: (message) => errors.push(message),
    openPostgres: async () => { opened = true; },
  });
  assert.equal(result.exitCode, EXIT_CODES.configurationRejected);
  assert.equal(opened, false);
  assert.match(errors[0], /api configuration rejected: PGHOST is missing/);
});

test('worker in postgres mode verifies the store, closes it, and still reports the missing source adapter', async () => {
  const persistence = fakePersistence();
  let opened;
  const errors = [];
  const result = await runCli({
    mode: 'worker', env: workerEnv(PG_ENV), stderr: (message) => errors.push(message),
    openPostgres: async (settings) => { opened = settings; return persistence; },
  });
  assert.equal(result.exitCode, EXIT_CODES.sourceAdapterMissing);
  assert.equal(opened.claimTimeoutMs, 30_000);
  assert.equal(persistence.closed, 1);
  assert.match(errors.at(-1), /postgres persistence\), but no production source adapter/);
});

test('worker reports an unavailable store as a runtime failure with the secret redacted', async () => {
  const errors = [];
  const result = await runCli({
    mode: 'worker', env: workerEnv(PG_ENV), stderr: (message) => errors.push(message),
    openPostgres: async () => { throw new Error('database is unavailable (ECONNREFUSED); password=TOP_SECRET'); },
  });
  assert.equal(result.exitCode, EXIT_CODES.runtimeFailure);
  assert.match(errors[0], /worker persistence unavailable: database is unavailable/);
  assert.doesNotMatch(errors.join('\n'), /TOP_SECRET/);
});

test('API binds loopback by default and HOST opts into another address', async () => {
  const persistence = fakePersistence();
  const openPostgres = async () => persistence;
  const port = await availablePort();
  const output = [];
  const running = await runCli({ mode: 'api', env: { ...PG_ENV, PORT: String(port), HOST: '0.0.0.0' }, stdout: (message) => output.push(message), openPostgres });
  try {
    assert.equal(running.server.address().address, '0.0.0.0');
    assert.match(output[0], new RegExp(`API ready on http://0\.0\.0\.0:${port}`));
    assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
  } finally {
    await running.close();
  }

  const loopback = await runCli({ mode: 'api', env: { ...PG_ENV, PORT: String(await availablePort()) }, stdout: () => {}, openPostgres });
  try {
    assert.equal(loopback.server.address().address, '127.0.0.1');
  } finally {
    await loopback.close();
  }

  const errors = [];
  const rejected = await runCli({ mode: 'api', env: { ...PG_ENV, HOST: 'example.com' }, stderr: (message) => errors.push(message), openPostgres });
  assert.equal(rejected.exitCode, EXIT_CODES.configurationRejected);
  assert.match(errors[0], /invalid HOST: example\.com/);
});
