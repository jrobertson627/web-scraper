import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileRawStore, InMemoryPersistence } from '../src/persistence/index.mjs';
import { definePersistenceConformance } from '../fixtures/persistence-conformance.mjs';

// The persistence conformance suite (#46) for the in-memory adapter, with the
// filesystem raw store that production uses. scripts/postgres-integration.mjs
// runs the same suite against PostgreSQL.
definePersistenceConformance(test, {
  label: 'in-memory',
  createStores: async () => ({ persistence: new InMemoryPersistence(), rawStore: new FileRawStore(mkdtempSync(join(tmpdir(), 'conformance-'))) }),
});

test('reconcile mode reports on the durable store and exits 5 when the report names failures', async () => {
  const { createFixtureApplication } = await import('../src/application/composition-root.mjs');
  const { foundationCorpus } = await import('../fixtures/foundation-corpus.mjs');
  const { EXIT_CODES, runCli } = await import('../src/application/cli.mjs');
  const assert = (await import('node:assert/strict')).default;
  const env = { PERSISTENCE: 'postgres', PGHOST: 'db.internal', PGDATABASE: 'scraper', PGUSER: 'scraper', PGPASSWORD: 'TOP_SECRET' };
  const events = [];
  const run = async (faults, args = [], overrides = {}) => {
    const app = createFixtureApplication({ fixtureEntries: foundationCorpus({ faults }) });
    await app.runWorkerOnce();
    const output = [];
    const errors = [];
    let closed = 0;
    const persistence = Object.assign(Object.create(app.persistence), { close: async () => { closed += 1; } });
    const result = await runCli({ mode: 'reconcile', env: { ...env, ...overrides }, args, stdout: (line) => output.push(line),
      stderr: (line) => errors.push(line), crawlLog: { emit: (name, fields) => events.push([name, fields]) }, openPostgres: async () => persistence });
    return { ...result, output, errors, closed };
  };
  const clean = await run(false, ['--require-coverage']);
  assert.equal(clean.exitCode, EXIT_CODES.success);
  assert.equal(JSON.parse(clean.output[0]).passed, true);
  assert.equal(clean.closed, 1);
  const faulty = await run(true);
  assert.equal(faulty.exitCode, EXIT_CODES.reconciliationFailed);
  assert.equal(JSON.parse(faulty.output[0]).quarantined.length, 2);
  assert.deepEqual(events.map(([name]) => name), ['reconciliation.completed', 'reconciliation.completed']);
  assert.equal((await run(false, [], { PERSISTENCE: 'memory' })).exitCode, EXIT_CODES.configurationRejected);
  const bad = await run(false, ['--everything']);
  assert.equal(bad.exitCode, EXIT_CODES.configurationRejected);
  assert.doesNotMatch(bad.errors.join(' '), /TOP_SECRET/);
});
