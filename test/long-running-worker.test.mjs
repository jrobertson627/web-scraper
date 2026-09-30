import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createJob } from '../src/contracts/boundaries.mjs';
import { createSourceUrl, canonicalizeSourceUrl } from '../src/contracts/source.mjs';
import { contractFingerprint } from '../src/config/data-contract.mjs';
import { FixtureTransport } from '../src/fetcher/index.mjs';
import { InMemoryPersistence } from '../src/persistence/index.mjs';
import { createFixtureApplication } from '../src/application/composition-root.mjs';
import { runWorkerLoop } from '../src/application/worker-loop.mjs';
import { runCli, EXIT_CODES } from '../src/application/cli.mjs';
import { foundationCorpus } from '../fixtures/foundation-corpus.mjs';

// A fixture crawl over the foundation corpus whose transport can be scripted.
function crawl({ respond, fetcherSleep } = {}) {
  let milliseconds = Date.parse('2026-01-01T00:00:00.000Z');
  const clock = () => new Date(milliseconds);
  const sleeps = [];
  const sleep = fetcherSleep ?? (async (ms) => { sleeps.push(ms); milliseconds += ms; });
  const fixtures = new FixtureTransport(new Map(foundationCorpus().map((entry) => [entry.url, entry])));
  const transport = { calls: [], async request(request) {
    this.calls.push(request.url);
    return (await respond?.(request, this.calls.length)) ?? fixtures.request(request);
  } };
  const persistence = new InMemoryPersistence(clock, { claimTimeoutMs: 30_000 });
  const app = createFixtureApplication({ fixtureEntries: foundationCorpus(), sharedState: { clock, sleep, persistence, transport } });
  return { app, persistence, transport, sleeps, sleep };
}

test('a run whose only remaining job is in retry_wait waits for it and then processes it', async () => {
  const { app, persistence, sleeps, sleep } = crawl({ respond: (_request, call) => (call === 1 ? { status: 503, headers: {}, body: Buffer.alloc(0) } : null) });
  await app.ready;
  const result = await app.orchestrator.run({ workerId: 'long-runner', sleep });

  assert.equal(result.stopped, false);
  assert.deepEqual(Object.keys(result.counts), ['parsed']);
  assert.equal(result.counts.parsed, persistence.jobs.size);
  assert.equal(result.outcomes.retry_wait, 1);
  assert.equal('jobs' in result, false);
  assert.ok(sleeps.some((ms) => ms >= 1_000), 'the worker slept until the retry fell due');
});

test('the idle sleep is bounded by maxIdleMs and the run exits when only operator-held work remains', async () => {
  let milliseconds = Date.parse('2026-01-01T00:00:00.000Z');
  const clock = () => new Date(milliseconds);
  const persistence = new InMemoryPersistence(clock);
  const url = (path) => createSourceUrl('provider', `https://allowed.example/${path}`);
  const make = (path, parentKey) => createJob({ key: `provider:allowed.example/${path}:season`, parentKey, pageType: 'season', sourceUrl: url(path), canonicalPath: canonicalizeSourceUrl(url(path)) });
  persistence.addJob(make('parent'));
  persistence.addJob(make('child', make('parent').key));
  persistence.addJob(make('grandchild', make('child').key));
  persistence.addJob(make('later'));
  const parent = persistence.claimNextJob(clock(), 'setup');
  persistence.transitionJob(parent.key, 'operator_stop', parent.lease, { lastError: 'challenge' });
  const later = persistence.claimNextJob(clock(), 'setup');
  persistence.transitionJob(later.key, 'retry_wait', later.lease, { nextAllowedAt: new Date(milliseconds + 3_600_000).toISOString() });
  assert.deepEqual(persistence.workOutlook(), { remaining: 1, wakeInMs: 3_600_000 });

  const sleeps = [];
  const fetched = [];
  const { IngestionOrchestrator } = await import('../src/application/orchestrator.mjs');
  const orchestrator = new IngestionOrchestrator({
    fetcher: { fetch: async (job) => { fetched.push(job.key); return { kind: 'permanently_failed', reason: 'gone' }; } },
    discovery: {}, parsers: {}, normalizer: {}, persistence, rawStore: {}, clock,
  });
  const result = await orchestrator.run({ maxIdleMs: 60_000, sleep: async (ms) => { sleeps.push(ms); milliseconds += ms; } });
  assert.deepEqual(sleeps, Array(60).fill(60_000));
  assert.deepEqual(fetched, [later.key]);
  assert.deepEqual(result.counts, { operator_stop: 1, pending: 2, permanently_failed: 1 });
  assert.deepEqual(persistence.workOutlook(), { remaining: 0, wakeInMs: null });
});

test('SIGTERM during a request lets it finish, releases the host, leaves nothing fetching and stops claiming', async () => {
  const signals = new EventEmitter();
  let requestStarted;
  const started = new Promise((resolve) => { requestStarted = resolve; });
  const { app, persistence, transport, sleep } = crawl({ respond: async (_request, call) => {
    if (call === 2) { requestStarted(); await new Promise((resolve) => setTimeout(resolve, 20)); }
    return null;
  } });
  await app.ready;
  const logs = [];
  const running = runWorkerLoop({ orchestrator: app.orchestrator, workerId: 'signalled', signals, log: (line) => logs.push(line), sleep });
  await started;
  signals.emit('SIGTERM');
  signals.emit('SIGTERM');
  const result = await running;

  assert.equal(result.stopped, true);
  assert.equal(transport.calls.length, 2);
  assert.equal(persistence.inFlight.size, 0);
  const states = persistence.listJobs().map((job) => job.state);
  assert.equal(states.includes('fetching') || states.includes('fetched'), false);
  assert.equal(result.counts.parsed, 2);
  assert.ok(result.counts.pending > 0);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /SIGTERM/);
  assert.equal(signals.listenerCount('SIGTERM') + signals.listenerCount('SIGINT'), 0);
});

test('SIGINT while waiting for the host pacing window skips the request and releases the host uncharged', async () => {
  const signals = new EventEmitter();
  // The pacing sleep never finishes on its own; only the signal ends it.
  const { app, persistence, transport } = crawl({ fetcherSleep: () => new Promise(() => {}) });
  await app.ready;
  persistence.recordRequestStart('fixture.example', app.clock());
  const running = runWorkerLoop({ orchestrator: app.orchestrator, workerId: 'paced', signals });
  await new Promise((resolve) => setTimeout(resolve, 20));
  signals.emit('SIGINT');
  const result = await running;

  assert.equal(result.stopped, true);
  assert.equal(transport.calls.length, 0);
  assert.equal(persistence.inFlight.size, 0);
  const job = persistence.listJobs()[0];
  assert.equal(job.state, 'retry_wait');
  assert.equal(job.failureAttempts, 0);
  assert.match(job.lastError, /worker stopped before the request started/);
});

test('an idle worker wakes up and returns promptly on SIGTERM', async () => {
  const signals = new EventEmitter();
  const { app, persistence } = crawl();
  await app.ready;
  const root = persistence.claimNextJob(app.clock(), 'setup');
  persistence.transitionJob(root.key, 'retry_wait', root.lease, { nextAllowedAt: new Date(app.clock().getTime() + 3_600_000).toISOString() });
  const began = Date.now();
  const running = runWorkerLoop({ orchestrator: app.orchestrator, signals, maxIdleMs: 3_600_000 });
  setTimeout(() => signals.emit('SIGTERM'), 20);
  const result = await running;
  assert.equal(result.stopped, true);
  assert.equal(result.processed, 0);
  assert.ok(Date.now() - began < 5_000);
});

test('worker mode runs an assembled worker to completion and reports counts', async () => {
  const dataContract = { providerId: 'provider', version: 'v1', retainedFields: ['school'], attribution: 'Provider', sourceLinksRequired: true, redistribution: 'private', retention: 'indefinite' };
  const authorization = { providerId: 'provider', status: 'active', uses: ['crawl'], evidenceRef: 'private-record', contractVersion: 'v1', contractFingerprint: contractFingerprint(dataContract),
    scope: { allowedHosts: ['provider.example'], eligibilityPredicate: 'To == CurrentSeasonEndingYear', targetEndingYears: 'CurrentSeasonEndingYear-4..CurrentSeasonEndingYear' } };
  const env = { USER_AGENT: 'test (+ops@example.com)', RAW_STORE_ROOT: process.cwd(), AUTHORIZATION_JSON: JSON.stringify(authorization), DATA_CONTRACT_JSON: JSON.stringify(dataContract) };
  const { app, sleep } = crawl();
  let closed = 0;
  const output = [];
  const listeners = process.listenerCount('SIGTERM');
  const result = await runCli({ mode: 'worker', env, stdout: (line) => output.push(line), stderr: () => {},
    startWorker: async ({ config }) => {
      assert.equal(config.providerId, 'provider');
      await app.ready;
      return { orchestrator: { run: (options) => app.orchestrator.run({ ...options, sleep }) }, close: async () => { closed += 1; } };
    } });
  assert.equal(result.exitCode, EXIT_CODES.success);
  assert.equal(closed, 1);
  const report = JSON.parse(output.at(-1));
  assert.equal(report.mode, 'worker');
  assert.equal(report.stopped, false);
  assert.deepEqual(Object.keys(report.counts), ['parsed']);
  assert.equal(process.listenerCount('SIGTERM'), listeners);
});
