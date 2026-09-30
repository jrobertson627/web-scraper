import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJob } from '../src/contracts/boundaries.mjs';
import { canonicalizeSourceUrl, createSourceUrl } from '../src/contracts/source.mjs';
import { Fetcher } from '../src/fetcher/index.mjs';
import { FileRawStore, InMemoryPersistence, MemoryRawStore } from '../src/persistence/index.mjs';
import { HealthMonitor } from '../src/application/health-monitor.mjs';
import { IngestionOrchestrator } from '../src/application/orchestrator.mjs';
import { disposeMatching, formatReviewList, listForReview, releaseHalt } from '../src/application/review.mjs';
import { EXIT_CODES, parseReviewArgs, runCli } from '../src/application/cli.mjs';

// #114: a failure that affects every page halts the run instead of being charged
// to the pages, and permanently_failed is recoverable.

const HOST = 'allowed.example';
const START = Date.parse('2026-01-01T00:00:00.000Z');
const MINUTE = 60_000;

test('the monitor charges ordinary failures, opens on a run of them across pages, and backs off', () => {
  let now = START;
  const monitor = new HealthMonitor({ clock: () => new Date(now) });
  assert.deepEqual(monitor.recordFailure('a'), { action: 'charge' });
  assert.deepEqual(monitor.recordFailure('b'), { action: 'charge' });
  const opened = monitor.recordFailure('c');
  assert.deepEqual([opened.action, opened.opens, opened.pauseUntil.getTime() - now], ['pause', 1, 5 * MINUTE]);
  assert.equal(monitor.waitUntil().getTime(), START + 5 * MINUTE);
  now += 5 * MINUTE;
  assert.equal(monitor.waitUntil(), null, 'the pause has passed');
  // One probe request; failing it re-opens at once, for twice as long.
  const reopened = monitor.recordFailure('d');
  assert.deepEqual([reopened.action, reopened.opens, reopened.pauseUntil.getTime() - now], ['pause', 2, 10 * MINUTE]);
  now += 10 * MINUTE;
  monitor.recordSuccess();
  assert.deepEqual([monitor.opens, monitor.waitUntil()], [0, null], 'a success resets everything');
  assert.deepEqual(monitor.recordFailure('e'), { action: 'charge' });
});

test('failures of a single page never open the monitor, and the pause is capped', () => {
  let now = START;
  const same = new HealthMonitor({ clock: () => new Date(now) });
  for (let attempt = 0; attempt < 10; attempt += 1) assert.equal(same.recordFailure('one page').action, 'charge');

  const monitor = new HealthMonitor({ pauseBaseMs: MINUTE, pauseMaxMs: 3 * MINUTE, opensToHalt: 5, clock: () => new Date(now) });
  monitor.recordFailure('a'); monitor.recordFailure('b');
  const pauses = [];
  const note = (verdict) => pauses.push([verdict.action, verdict.pauseUntil.getTime() - now]);
  note(monitor.recordFailure('c'));
  for (let open = 0; open < 4; open += 1) { now += 10 * MINUTE; note(monitor.recordFailure(`p${open}`)); }
  assert.deepEqual(pauses, [['pause', MINUTE], ['pause', 2 * MINUTE], ['pause', 3 * MINUTE], ['pause', 3 * MINUTE], ['halt', 3 * MINUTE]],
    'doubling, then capped, then a halt on the fifth open');
  assert.throws(() => new HealthMonitor({ failuresToOpen: 0 }), /failuresToOpen must be a positive integer/);
});

// A worker whose transport answers from a function of the request number.
function harness({ answer, jobs = 10, policy = {}, health, minFreeBytes = 0, rawStore = new MemoryRawStore() } = {}) {
  let now = START;
  const clock = () => new Date(now);
  const persistence = new InMemoryPersistence(clock, { claimTimeoutMs: 30_000, authorizeOperator: (id) => id === 'ops' });
  const requests = [];
  const transport = { async request({ url }) { requests.push({ url, at: now }); return answer(requests.length, url); } };
  const events = [];
  const fetcher = new Fetcher({
    transport, rawStore, persistence, clock, sleep: async (ms) => { now += ms; }, allowedHosts: [HOST],
    policy: { minIntervalMs: 6_000, maxRequestsPerMinute: 10, hostConcurrency: 1, userAgent: 'scraper (+ops@example.com)', maxAttempts: 3, retryBaseMs: 1_000, retryMaxMs: 60_000, ...policy },
  });
  const orchestrator = new IngestionOrchestrator({
    fetcher, discovery: { discover: () => ({ observations: [], childJobs: [], unavailableCoverage: [], warnings: [] }) }, parsers: {}, normalizer: {},
    persistence, rawStore, clock, events: { emit: (name, fields) => events.push([name, fields]) }, health, minFreeBytes,
  });
  for (let index = 0; index < jobs; index += 1) {
    const sourceUrl = createSourceUrl('provider', `https://${HOST}/p${index}`);
    persistence.addJob(createJob({ key: `provider:${HOST}/p${index}:season`, pageType: 'season', sourceUrl, canonicalPath: canonicalizeSourceUrl(sourceUrl) }));
  }
  return { persistence, orchestrator, requests, events, clock, advance: (ms) => { now += ms; }, sleep: async (ms) => { now += ms; } };
}
const networkDown = () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND allowed.example'), { code: 'transient_network' }); };
const serverDown = () => ({ status: 503, headers: {}, body: Buffer.alloc(0) });
const ok = () => ({ status: 200, headers: {}, body: Buffer.from('{}') });
const states = (run) => Object.fromEntries(Object.entries(Object.groupBy(run.persistence.listJobs(), (job) => job.state)).map(([state, list]) => [state, list.length]));

for (const [label, answer] of [['a network or DNS outage', networkDown], ['a 5xx period', serverDown]]) {
  test(`${label}: the run halts after a bounded number of requests and no page becomes permanently_failed`, async () => {
    const run = harness({ answer });
    const result = await run.orchestrator.run({ workerId: 'worker', sleep: run.sleep, maxIdleMs: 60 * MINUTE, minIdleMs: 250 });
    assert.equal(result.halt.reason, 'systemic_failures');
    assert.equal(result.stopReason, 'systemic_failures');
    assert.ok(run.requests.length <= 8, `${run.requests.length} requests`);
    const counts = states(run);
    assert.equal(counts.permanently_failed, undefined, 'no page was lost');
    assert.equal(counts.parse_failed, undefined);
    assert.ok(run.persistence.listJobs().every((job) => (job.failureAttempts ?? 0) <= 1), 'the few pages charged before the pause were charged once');
    assert.ok(run.events.some(([name]) => name === 'health.paused'));
    assert.deepEqual(run.persistence.unreviewedRunHalts().map((halt) => halt.code), ['systemic_failures'], 'the halt is recorded');
  });
}

test('a restarted worker makes no request while the halt is unreleased, and resumes once an operator releases it', async () => {
  let healthy = false;
  const run = harness({ answer: () => (healthy ? ok() : networkDown()) });
  await run.orchestrator.run({ workerId: 'worker', sleep: run.sleep, maxIdleMs: 60 * MINUTE });
  const after = run.requests.length;
  const restarted = await run.orchestrator.run({ workerId: 'worker', sleep: run.sleep });
  assert.deepEqual([restarted.stopReason, restarted.processed, run.requests.length], ['systemic_failures', 0, after]);

  healthy = true;
  const [halt] = run.persistence.unreviewedRunHalts();
  await assert.rejects(releaseHalt({ persistence: run.persistence, haltId: halt.haltId, operatorId: 'intruder', reason: 'x' }), /not authorized/);
  await releaseHalt({ persistence: run.persistence, haltId: halt.haltId, operatorId: 'ops', reason: 'the network is back' });
  assert.deepEqual(run.persistence.unreviewedRunHalts(), []);
  const resumed = await run.orchestrator.run({ workerId: 'worker', sleep: run.sleep, maxIdleMs: 60 * MINUTE });
  assert.equal(resumed.halt, undefined);
  assert.equal(states(run).parse_failed, 10, 'every page was then fetched (the stub parsers reject them)');
});

test('a short outage pauses the run and it carries on, with no page charged past the first few', async () => {
  const run = harness({ answer: (number) => (number <= 4 ? networkDown() : ok()) });
  const result = await run.orchestrator.run({ workerId: 'worker', sleep: run.sleep, maxIdleMs: 60 * MINUTE });
  assert.equal(result.halt, undefined);
  assert.equal(states(run).parse_failed, 10);
  assert.equal(run.persistence.unreviewedRunHalts().length, 0);
  assert.ok(run.persistence.listJobs().every((job) => (job.failureAttempts ?? 0) <= 1));
});

test('failures that name the page are not counted: a run of 404s or 429s never opens the monitor', async () => {
  const notFound = harness({ answer: () => ({ status: 404, headers: {}, body: Buffer.alloc(0) }), jobs: 6, policy: { notFoundRetryBaseMs: 1_000 } });
  await notFound.orchestrator.runOnce('worker');
  assert.equal(notFound.events.filter(([name]) => name === 'health.paused').length, 0);
  assert.equal(notFound.orchestrator.health.waitUntil(), null);
  // Each page failed on its own, retried (on a 1 s backoff here) and then given up on: the monitor never intervened.
  assert.equal(states(notFound).permanently_failed, 6);
});

test('a page that keeps failing on its own is still charged and ends permanently_failed', async () => {
  let call = 0;
  const run = harness({ jobs: 3, answer: (number, url) => { call += 1; return url.endsWith('/p0') ? networkDown() : ok(); } });
  const result = await run.orchestrator.run({ workerId: 'worker', sleep: run.sleep, maxIdleMs: 60 * MINUTE });
  assert.equal(result.halt, undefined);
  const bad = run.persistence.getJob('provider:allowed.example/p0:season');
  assert.equal(bad.state, 'permanently_failed');
  assert.equal(bad.failureAttempts, 2);
  assert.ok(call > 3);
});

test('a raw disk with too little free space halts the run before any request', async () => {
  const rawStore = new MemoryRawStore();
  let free = 100;
  rawStore.freeBytes = () => free;
  const run = harness({ answer: ok, rawStore, minFreeBytes: 1_000 });
  const result = await run.orchestrator.run({ workerId: 'worker', sleep: run.sleep });
  assert.deepEqual([result.stopReason, run.requests.length], ['raw_disk_low', 0]);
  assert.match(result.halt.detail, /100 bytes free, below the 1000 minimum/);
  assert.deepEqual(run.persistence.unreviewedRunHalts().map((halt) => halt.code), ['raw_disk_low']);
  // With room, after the halt is released, the crawl goes on.
  free = 5_000;
  run.persistence.releaseRunHalt(run.persistence.unreviewedRunHalts()[0].haltId, { operatorId: 'ops', reason: 'disk enlarged' });
  assert.equal((await run.orchestrator.run({ workerId: 'worker', sleep: run.sleep })).halt, undefined);
  assert.equal(run.requests.length, 10);
});

test('the raw store reports the disk space it has, and the in-memory store cannot run out', async () => {
  const root = mkdtempSync(join(tmpdir(), 'raw-free-'));
  try {
    const free = await new FileRawStore(root).freeBytes();
    assert.ok(Number.isFinite(free) && free > 0);
    assert.equal(new MemoryRawStore().freeBytes(), Number.POSITIVE_INFINITY);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// permanently_failed is recoverable (#114).
function failedJobs(run) {
  const keys = [];
  for (let index = 0; index < 3; index += 1) {
    const job = run.persistence.claimNextJob(run.clock(), 'worker');
    run.persistence.transitionJob(job.key, 'retry_wait', job.lease, { nextAllowedAt: run.clock().toISOString(), charge: 'failure' });
    const again = run.persistence.claimNextJob(run.clock(), 'worker');
    run.persistence.transitionJob(again.key, 'permanently_failed', again.lease, { lastError: 'network error; retry limit reached', code: index === 2 ? 'upstream_5xx' : 'transient_network' });
    keys.push(again.key);
  }
  return keys;
}

test('an operator requeues a permanently_failed page with a fresh budget, and it is crawled again', async () => {
  const run = harness({ answer: ok, jobs: 4 });
  const keys = failedJobs(run);
  const job = run.persistence.getJob(keys[0]);
  assert.deepEqual([job.state, job.failureAttempts], ['permanently_failed', 1]);

  run.persistence.recordOperatorDisposition(keys[0], { kind: 'requeue_failed', operatorId: 'ops', reason: 'the outage is over' });
  const back = run.persistence.getJob(keys[0]);
  assert.deepEqual([back.state, back.failureAttempts, back.rateLimitAttempts, back.claimRecoveries ?? 0], ['retry_wait', 0, 0, 0]);
  assert.equal(run.persistence.operatorDispositions.at(-1).kind, 'requeue_failed');
  await run.orchestrator.runOnce('worker');
  assert.equal(run.persistence.getJob(keys[0]).state, 'parse_failed', 'it was fetched again (the stub parsers reject it)');

  // The wrong state is refused each way round.
  assert.throws(() => run.persistence.recordOperatorDisposition(keys[1], { kind: 'release_retry', operatorId: 'ops', reason: 'x' }), /requires operator_stop/);
  const pending = run.persistence.listJobs().find((entry) => entry.state !== 'permanently_failed');
  assert.ok(pending);
  assert.throws(() => run.persistence.recordOperatorDisposition(pending.key, { kind: 'requeue_failed', operatorId: 'ops', reason: 'x' }), /requires permanently_failed/);
  assert.throws(() => run.persistence.recordOperatorDisposition(keys[1], { kind: 'requeue_failed', operatorId: 'intruder', reason: 'x' }), /not authorized/);
});

test('one command requeues every page that failed the same way, one disposition each', async () => {
  const run = harness({ answer: ok, jobs: 3 });
  const keys = failedJobs(run);
  const common = { persistence: run.persistence, action: 'requeue', states: ['permanently_failed'], code: 'transient_network', operatorId: 'ops', reason: 'the network is back', clock: run.clock };
  const listed = run.persistence.reviewJobs({ states: ['permanently_failed'] }).items;
  assert.deepEqual(listed.map((item) => item.code), ['transient_network', 'transient_network', 'upstream_5xx'], 'each failure records its code');
  assert.equal((await disposeMatching({ ...common, dryRun: true })).matched, 2);
  const done = await disposeMatching(common);
  assert.deepEqual([done.matched, done.disposed], [2, 2]);
  assert.deepEqual(keys.map((key) => run.persistence.getJob(key).state), ['retry_wait', 'retry_wait', 'permanently_failed']);
  assert.equal(run.persistence.operatorDispositions.filter((entry) => entry.kind === 'requeue_failed').length, 2);
  // The default review list still shows only what needs a decision.
  assert.deepEqual(run.persistence.reviewJobs().items, []);
  assert.throws(() => run.persistence.reviewJobs({ states: ['parsed'] }), /review states are invalid/);
});

test('halts show in the review list with the command to release them', async () => {
  const run = harness({ answer: ok, jobs: 1 });
  run.persistence.recordRunHalt({ reason: 'raw_disk_low', detail: 'the raw store has 5 bytes free' });
  const list = await listForReview({ persistence: run.persistence });
  assert.deepEqual(list.halts.map((halt) => [halt.id, halt.reason]), [['halt-1', 'raw_disk_low']]);
  const text = formatReviewList(list);
  assert.match(text, /Halts awaiting release \(1\)/);
  assert.match(text, /halt-1\s+raw_disk_low/);
  assert.match(text, /release-halt <id> --operator/);
  assert.equal(run.persistence.unreviewedChallenges()[0].code, 'raw_disk_low', 'a halt blocks a start like a challenge stop');
  await assert.rejects(releaseHalt({ persistence: run.persistence, haltId: 'nonsense', operatorId: 'ops', reason: 'x' }), /halt id nonsense is invalid/);
  await assert.rejects(releaseHalt({ persistence: run.persistence, haltId: 'halt-9', operatorId: 'ops', reason: 'x' }), /halt-9 does not exist/);
  await releaseHalt({ persistence: run.persistence, haltId: 'halt-1', operatorId: 'ops', reason: 'freed space' });
  await assert.rejects(releaseHalt({ persistence: run.persistence, haltId: 'halt-1', operatorId: 'ops', reason: 'again' }), /already released/);
  assert.equal(formatReviewList(await listForReview({ persistence: run.persistence })).includes('Halts awaiting release'), false);
});

test('the review command takes release-halt and requeue', () => {
  const release = parseReviewArgs(['release-halt', 'halt-3', '--operator', 'ops', '--reason', 'freed space']);
  assert.deepEqual([release.command, release.target, release.operatorId], ['release-halt', 'halt-3', 'ops']);
  const bulk = parseReviewArgs(['requeue', '--state', 'permanently_failed', '--code', 'transient_network', '--operator', 'ops', '--reason', 'outage over']);
  assert.deepEqual(bulk.bulk, { states: ['permanently_failed'], code: 'transient_network', dryRun: false });
  assert.equal(parseReviewArgs(['requeue', 'some-job', '--operator', 'ops', '--reason', 'x']).target, 'some-job');
});

test('worker mode retries a failing page over minutes and watches the raw disk by default', async () => {
  const record = (name) => JSON.parse(readFileSync(new URL(`../config/personal-use.${name}.json`, import.meta.url), 'utf8'));
  const authorization = record('authorization');
  const env = {
    USER_AGENT: 'test (+ops@example.com)', RAW_STORE_ROOT: process.cwd(), PERSISTENCE: 'postgres', PGHOST: 'db', PGDATABASE: 'scraper', PGUSER: 'scraper',
    PROVIDER_ID: authorization.providerId, PROVIDER_HOST: authorization.scope.allowedHosts[0],
    AUTHORIZATION_JSON: JSON.stringify(authorization), DATA_CONTRACT_JSON: JSON.stringify(record('data-contract')),
  };
  const errors = [];
  let started;
  const run = (overrides) => runCli({ mode: 'worker', env: { ...env, ...overrides }, stdout: () => {}, stderr: (line) => errors.push(line),
    startWorker: async ({ config }) => { started = config; throw new Error('stop here'); } });
  await run({});
  assert.deepEqual([started.policy.maxAttempts, started.policy.retryBaseMs, started.policy.retryMaxMs, started.rawMinFreeBytes], [5, 60_000, 600_000, 512 * 1024 * 1024]);
  await run({ RAW_MIN_FREE_BYTES: '0' });
  assert.equal(started.rawMinFreeBytes, 0);
  assert.equal((await run({ RAW_MIN_FREE_BYTES: 'lots' })).exitCode, EXIT_CODES.configurationRejected);
  assert.match(errors.at(-1), /invalid RAW_MIN_FREE_BYTES/);
});
