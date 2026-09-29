import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli, EXIT_CODES } from '../src/application/cli.mjs';
import { createCrawlLog } from '../src/application/crawl-log.mjs';
import { startProductionWorker } from '../src/application/production-worker.mjs';
import { createParseResult } from '../src/contracts/boundaries.mjs';
import { PAGE_TYPES } from '../src/contracts/source.mjs';
import { FixtureTransport } from '../src/fetcher/index.mjs';
import { HttpTransport } from '../src/fetcher/http-transport.mjs';
import { createProductionParserRegistry } from '../src/parsers/index.mjs';
import { PostgresPersistence, expectedMigrationVersions, openPostgresPersistence } from '../src/persistence/postgres.mjs';

// Worker mode wired to createWorkerApplication, the run loop and the crawl log
// (#97). No test opens a connection or makes a request: persistence is a
// PostgresPersistence whose job methods are overridden in memory, and the
// transport is never called because no job is claimable.

const record = (name) => JSON.parse(readFileSync(new URL(`../config/personal-use.${name}.json`, import.meta.url), 'utf8'));
const authorization = record('authorization');
const PG_ENV = { PERSISTENCE: 'postgres', PGHOST: 'db.internal', PGDATABASE: 'scraper', PGUSER: 'worker' };
const ROOT_KEY = 'sports-reference:www.sports-reference.com/cbb/schools:school_index';

function workerEnv(overrides = {}) {
  return {
    PROVIDER_ID: authorization.providerId, PROVIDER_HOST: authorization.scope.allowedHosts[0],
    USER_AGENT: 'web-scraper-test (+ops@example.com)', RAW_STORE_ROOT: mkdtempSync(join(tmpdir(), 'worker-wiring-')),
    AUTHORIZATION_JSON: JSON.stringify(authorization), DATA_CONTRACT_JSON: JSON.stringify(record('data-contract')),
    ...PG_ENV, ...overrides,
  };
}

// Job methods answer from memory; the pool is never queried.
class InMemoryPostgres extends PostgresPersistence {
  constructor(options) {
    super({ pool: { end: async () => {} }, ...options });
    this.added = [];
    this.closed = 0;
  }
  async addJob(job) { this.added.push(job); return job; }
  async recordCrawlScope(scope) { this.scopes = [...(this.scopes ?? []), scope]; return { scope, changed: true, widened: false, previous: null }; }
  async claimNextJob() { return null; }
  async workOutlook() { return { remaining: 0 }; }
  async jobCounts() { return { pending: this.added.length }; }
  async close() { this.closed += 1; }
}

class StubParser {
  constructor(pageType) { this.type = pageType; }
  pageType() { return this.type; }
  version() { return '1'; }
  parse() { return createParseResult({ kind: 'structural_failure', error: 'stub parser' }); }
}

const everyParser = () => createProductionParserRegistry(PAGE_TYPES.map((pageType) => new StubParser(pageType)));
const offlineTransport = () => new HttpTransport({ resolve: async () => { throw new Error('tests make no network requests'); } });

// runCli with the production startWorker, given fake persistence and parsers.
async function runWorker({ env = workerEnv(), parsers = everyParser(), transport = offlineTransport(), openPostgres } = {}) {
  const opened = [];
  const persistence = new InMemoryPostgres();
  const lines = [];
  const errors = [];
  const output = [];
  let worker;
  const crawlLog = createCrawlLog({ write: (line) => lines.push(JSON.parse(line)) });
  const result = await runCli({
    mode: 'worker', env, stdout: (line) => output.push(line), stderr: (line) => errors.push(line), crawlLog,
    openPostgres: openPostgres ?? (async (settings) => { opened.push(settings); return persistence; }),
    startWorker: async (context) => { worker = await startProductionWorker({ ...context, parsers, transport }); return worker; },
  });
  return { result, opened, persistence, lines, errors, output, worker, crawlLog };
}

test('worker mode builds the production app, seeds the root job, runs the loop and closes the store', async () => {
  const { result, opened, persistence, output, worker } = await runWorker();
  assert.equal(result.exitCode, EXIT_CODES.success);
  assert.equal(worker.app.config.mode, 'worker');
  assert.equal(worker.app.persistence, persistence);
  assert.deepEqual(persistence.added.map((job) => job.key), [ROOT_KEY]);
  assert.equal(opened.length, 1);
  assert.equal(persistence.closed, 1);
  const report = JSON.parse(output.at(-1));
  assert.equal(report.mode, 'worker');
  assert.equal(report.stopped, false);
  assert.deepEqual(report.counts, { pending: 1 });
});

test('worker mode opens PostgreSQL with the configured claim timeout and request deadline', async () => {
  const { opened } = await runWorker();
  assert.equal(opened[0].kind, 'postgres');
  assert.equal(opened[0].pool.host, 'db.internal');
  assert.equal(opened[0].claimTimeoutMs, 30_000);
  assert.equal(opened[0].requestTimeoutMs, 30_000, 'the policy default, not the 120 s persistence default');
});

test('the crawl log reaches the fetcher and orchestrator and ends the run with a job-state summary', async () => {
  const { worker, crawlLog, lines } = await runWorker();
  assert.equal(worker.app.orchestrator.events, crawlLog);
  assert.equal(worker.app.orchestrator.fetcher.events, crawlLog);
  const summary = lines.at(-1);
  assert.equal(summary.event, 'crawl.summary');
  assert.deepEqual(summary.jobStates, { pending: 1 });
  assert.equal(summary.stopped, false);
});

test('worker mode refuses to start while a production parser is missing, after checking the store', async () => {
  const partial = createProductionParserRegistry([new StubParser('school_index'), new StubParser('school_history')]);
  const { result, opened, persistence, errors } = await runWorker({ parsers: partial });
  assert.equal(result.exitCode, EXIT_CODES.workerNotReady);
  assert.equal(opened.length, 1);
  assert.equal(persistence.closed, 1);
  assert.deepEqual(persistence.added, []);
  assert.match(errors.at(-1), /\(postgres persistence\), but no production parser is registered for season@1, game_log@1, box_score@1; no crawl started/);
});

test('the default production parsers gate worker mode exactly as missingProductionParsers reports', async () => {
  const persistence = new InMemoryPostgres();
  const errors = [];
  const result = await runCli({ mode: 'worker', env: workerEnv(), stderr: (line) => errors.push(line), stdout: () => {},
    crawlLog: createCrawlLog({ write: () => {} }), openPostgres: async () => persistence,
    startWorker: (context) => startProductionWorker({ ...context, transport: offlineTransport() }) });
  if (result.exitCode === EXIT_CODES.workerNotReady) {
    assert.match(errors.at(-1), /no production parser is registered for /);
    assert.deepEqual(persistence.added, []);
  } else {
    // Every production parser has landed, so the worker starts.
    assert.equal(result.exitCode, EXIT_CODES.success);
    assert.deepEqual(persistence.added.map((job) => job.key), [ROOT_KEY]);
  }
  assert.equal(persistence.closed, 1);
});

test('worker mode refuses memory persistence for a real crawl', async () => {
  const { result, opened, errors } = await runWorker({ env: workerEnv({ PERSISTENCE: 'memory' }) });
  assert.equal(result.exitCode, EXIT_CODES.configurationRejected);
  assert.equal(opened.length, 0);
  assert.match(errors.at(-1), /a real crawl needs durable persistence, but PERSISTENCE is memory/);
});

test('an assembly refusal is a runtime failure that closes the store', async () => {
  const { result, persistence, errors } = await runWorker({ transport: new FixtureTransport() });
  assert.equal(result.exitCode, EXIT_CODES.runtimeFailure);
  assert.equal(persistence.closed, 1);
  assert.deepEqual(persistence.added, []);
  assert.match(errors.at(-1), /worker startup failed: worker assembly refused: transport must be HttpTransport/);
});

test('the authorization gate runs before the worker opens anything', async () => {
  const { result, opened, errors } = await runWorker({ env: workerEnv({ AUTHORIZATION_JSON: JSON.stringify({ ...authorization, status: 'revoked' }) }) });
  assert.equal(result.exitCode, EXIT_CODES.configurationRejected);
  assert.equal(opened.length, 0);
  assert.match(errors.at(-1), /worker configuration rejected: .*authorization is revoked/);
});

test('an unreachable store is a runtime failure with the secret redacted', async () => {
  const { result, errors } = await runWorker({ openPostgres: async () => { throw new Error('database is unavailable (ECONNREFUSED); password=TOP_SECRET'); } });
  assert.equal(result.exitCode, EXIT_CODES.runtimeFailure);
  assert.match(errors.at(-1), /worker persistence unavailable: database is unavailable/);
  assert.doesNotMatch(errors.join('\n'), /TOP_SECRET/);
});

test('openPostgresPersistence passes the lease, request-deadline and recovery options through', async () => {
  const pools = [];
  const createPool = (config) => {
    const pool = { config, on() {}, end: async () => {},
      query: async () => ({ rows: expectedMigrationVersions().map((version) => ({ version })) }) };
    pools.push(pool);
    return pool;
  };
  const persistence = await openPostgresPersistence({ pool: { host: 'db.internal' }, createPool,
    claimTimeoutMs: 45_000, requestTimeoutMs: 20_000, orphanGraceMs: 5_000, maxClaimRecoveries: 7 });
  assert.equal(pools[0].config.host, 'db.internal');
  assert.equal(pools[0].config.statement_timeout, 30_000);
  assert.equal(persistence.claimTimeoutMs, 45_000);
  assert.equal(persistence.requestDeadlineMs, 25_000);
  assert.equal(persistence.maxClaimRecoveries, 7);
  const defaults = await openPostgresPersistence({ createPool });
  assert.equal(defaults.requestDeadlineMs, 130_000, 'unset options keep the PostgresPersistence defaults');
  await assert.rejects(openPostgresPersistence({ createPool, requestTimeoutMs: 0 }), /requestTimeoutMs/);
});
