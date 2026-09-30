import test from 'node:test';
import assert from 'node:assert/strict';
import { createJob } from '../src/contracts/boundaries.mjs';
import { HOST_BUSY_WAIT_MS } from '../src/contracts/jobs.mjs';
import { canonicalizeSourceUrl, createSourceUrl } from '../src/contracts/source.mjs';
import { Fetcher } from '../src/fetcher/index.mjs';
import { InMemoryPersistence, MemoryRawStore } from '../src/persistence/index.mjs';
import { IngestionOrchestrator } from '../src/application/orchestrator.mjs';
import { disposeMatching } from '../src/application/review.mjs';
import { parseReviewArgs } from '../src/application/cli.mjs';

// #113: a 429 pauses the whole host, and a halting stop halts the run.
// #118: a busy host makes the worker wait instead of cycling through the queue.

const HOST = 'allowed.example';
const START = Date.parse('2026-01-01T00:00:00.000Z');
const jobFor = (name) => {
  const sourceUrl = createSourceUrl('provider', `https://${HOST}/${name}`);
  return createJob({ key: `provider:${HOST}/${name}:season`, pageType: 'season', sourceUrl, canonicalPath: canonicalizeSourceUrl(sourceUrl) });
};
const limited = (retryAfter) => ({ status: 429, headers: retryAfter === undefined ? {} : { 'retry-after': String(retryAfter) }, body: Buffer.alloc(0) });
const page = () => ({ status: 200, headers: {}, body: Buffer.from('{}') });

// A worker whose transport answers from a script and records when each request started.
function harness(script, { jobs = ['a', 'b'], policy = {} } = {}) {
  let now = START;
  const clock = () => new Date(now);
  const persistence = new InMemoryPersistence(clock, { claimTimeoutMs: 30_000, authorizeOperator: (id) => id === 'ops' });
  const rawStore = new MemoryRawStore();
  const requests = [];
  const transport = { async request({ url }) { requests.push({ url, at: now }); return script[Math.min(requests.length - 1, script.length - 1)]; } };
  const events = [];
  const fetcher = new Fetcher({
    transport, rawStore, persistence, clock, sleep: async (ms) => { now += ms; }, allowedHosts: [HOST],
    policy: { minIntervalMs: 6_000, maxRequestsPerMinute: 10, hostConcurrency: 1, userAgent: 'scraper (+ops@example.com)', ...policy },
  });
  const orchestrator = new IngestionOrchestrator({
    fetcher, discovery: { discover: () => ({ observations: [], childJobs: [], unavailableCoverage: [], warnings: [] }) }, parsers: {}, normalizer: {},
    persistence, rawStore, clock, events: { emit: (name, fields) => events.push([name, fields]) },
  });
  for (const name of jobs) persistence.addJob(jobFor(name));
  return { persistence, fetcher, orchestrator, requests, events, clock, advance: (ms) => { now += ms; }, sleeps: [] };
}

test('a 429 with a Retry-After pauses the host: the next job waits, uncharged, whichever it is', async () => {
  const run = harness([limited(3600), page()]);
  const first = run.persistence.claimNextJob(run.clock(), 'worker');
  const result = await run.fetcher.fetch(first, first.lease);
  assert.equal(result.kind, 'retry_wait');
  assert.equal(result.charge, 'rate_limit');
  assert.equal(run.persistence.getRequestSchedule(HOST).pausedUntil.getTime(), START + 3_600_000, 'the host, not just the page, is paused');
  run.persistence.transitionJob(first.key, 'retry_wait', first.lease, { nextAllowedAt: result.nextAllowedAt, charge: result.charge });

  const other = run.persistence.claimNextJob(run.clock(), 'worker');
  assert.notEqual(other.key, first.key);
  const paused = await run.fetcher.fetch(other, other.lease);
  assert.deepEqual([paused.kind, paused.code, paused.charge], ['retry_wait', 'host_paused', undefined], 'uncharged');
  assert.equal(paused.nextAllowedAt, new Date(START + 3_600_000).toISOString());
  assert.equal(run.requests.length, 1, 'no second request went out');
  run.persistence.transitionJob(other.key, 'retry_wait', other.lease, { nextAllowedAt: paused.nextAllowedAt });
  assert.equal(run.persistence.getJob(other.key).failureAttempts ?? 0, 0);

  run.advance(3_600_000);
  const later = run.persistence.claimNextJob(run.clock(), 'worker');
  assert.equal((await run.fetcher.fetch(later, later.lease)).kind, 'fetched');
});

test('a pause is never shortened by an earlier one', () => {
  const run = harness([page()]);
  run.persistence.pauseHost(HOST, new Date(START + 600_000));
  run.persistence.pauseHost(HOST, new Date(START + 60_000));
  assert.equal(run.persistence.getRequestSchedule(HOST).pausedUntil.getTime(), START + 600_000);
  run.persistence.pauseHost(HOST, new Date(START + 900_000));
  assert.equal(run.persistence.getRequestSchedule(HOST).pausedUntil.getTime(), START + 900_000);
  // Recording a request start keeps the pause.
  run.persistence.recordRequestStart(HOST, new Date(START));
  assert.equal(run.persistence.getRequestSchedule(HOST).pausedUntil.getTime(), START + 900_000);
});

test('the gate reports a pause, a busy host and a free one, and releases an orphaned request on its own', () => {
  const run = harness([page()], { jobs: ['a'] });
  assert.deepEqual(run.persistence.hostGate(HOST), { waitMs: 0, reason: null });
  run.persistence.pauseHost(HOST, new Date(START + 90_000));
  assert.deepEqual(run.persistence.hostGate(HOST), { waitMs: 90_000, reason: 'paused' });
  run.advance(90_000);
  assert.deepEqual(run.persistence.hostGate(HOST), { waitMs: 0, reason: null });

  const crashed = run.persistence.claimNextJob(run.clock(), 'crashed');
  run.persistence.acquireRequest(crashed.key, crashed.lease, HOST);
  assert.deepEqual(run.persistence.hostGate(HOST), { waitMs: HOST_BUSY_WAIT_MS, reason: 'in_flight' });
  run.advance(200_000); // past the claim's expiry and the request deadline: no live request can still be running
  assert.deepEqual(run.persistence.hostGate(HOST), { waitMs: 0, reason: null }, 'the orphan was released by the gate itself');
  assert.equal(run.persistence.inFlight.size, 0);
});

test('after a 429 with Retry-After 3600 no request starts for an hour, whichever job is claimed next', async () => {
  const run = harness([limited(3600), page(), page()]);
  const sleeps = [];
  const result = await run.orchestrator.run({
    workerId: 'worker', maxIdleMs: 60_000, minIdleMs: 250, sleep: async (ms) => { sleeps.push(ms); run.advance(ms); },
  });
  assert.equal(result.halt, undefined);
  assert.equal(run.requests.length, 3);
  const [rejected, ...rest] = run.requests;
  assert.ok(rest.every((request) => request.at - rejected.at >= 3_600_000), `requests after the 429 started at ${rest.map((r) => r.at - rejected.at)} ms`);
  assert.deepEqual(Object.keys(result.counts), ['parse_failed'], 'both pages were fetched (the stub parsers reject them); none is left waiting');
  assert.ok(sleeps.some((ms) => ms >= 1_000), 'the worker slept through the pause instead of claiming');
  assert.ok(run.events.some(([name, fields]) => name === 'host.waiting' && fields.reason === 'paused'));
});

test('a 429 without a usable Retry-After halts the run, and a restarted worker makes no request until it is reviewed', async () => {
  const run = harness([limited(undefined), page(), page()]);
  const first = await run.orchestrator.run({ workerId: 'worker', sleep: async () => {} });
  assert.deepEqual([first.stopped, first.stopReason, first.halt.reason], [true, 'invalid_retry_after', 'invalid_retry_after']);
  assert.equal(run.requests.length, 1);
  assert.equal(run.persistence.getRequestSchedule(HOST).pausedUntil, null, 'no pause to wait out: the run halts instead');

  const restarted = await run.orchestrator.run({ workerId: 'worker', sleep: async () => {} });
  assert.deepEqual([restarted.stopReason, restarted.processed], ['invalid_retry_after', 0]);
  assert.equal(run.requests.length, 1);

  const stopped = run.persistence.unreviewedChallenges();
  run.persistence.recordOperatorDisposition(stopped[0].jobKey, { kind: 'release_retry', operatorId: 'ops', reason: 'the provider confirmed the block is over' });
  const resumed = await run.orchestrator.run({ workerId: 'worker', sleep: async (ms) => { run.advance(ms); } });
  assert.equal(resumed.halt, undefined);
  assert.equal(run.requests.length, 3);
});

test('a retry-after longer than the policy allows halts the run', async () => {
  const run = harness([limited(7 * 86_400)], { policy: { maxRetryAfterMs: 86_400_000 } });
  const result = await run.orchestrator.run({ workerId: 'worker', sleep: async () => {} });
  assert.equal(result.halt.reason, 'retry_after_too_long');
  assert.equal(run.requests.length, 1);
});

test('an orphaned host lock makes the worker wait, not claim and settle every job, and it goes on once the lock clears', async () => {
  const run = harness([page()], { jobs: ['a', 'b', 'c', 'd', 'e', 'f'] });
  // A worker crashed mid-request: its request still holds the host.
  const crashed = run.persistence.claimNextJob(run.clock(), 'crashed');
  run.persistence.acquireRequest(crashed.key, crashed.lease, HOST);
  const before = run.persistence.listJobs().map((job) => [job.key, job.attempts, job.history.length]);
  const sleeps = [];
  let claims = 0;
  const claimNext = run.persistence.claimNextJob.bind(run.persistence);
  run.persistence.claimNextJob = (...args) => { claims += 1; return claimNext(...args); };

  const result = await run.orchestrator.run({
    workerId: 'worker', maxIdleMs: 30_000, minIdleMs: 250, sleep: async (ms) => { sleeps.push(ms); run.advance(ms); },
  });
  assert.equal(result.processed, 6, 'the crashed job and the five others were all crawled in the end');
  assert.ok(sleeps.length > 3, 'it waited on the host');
  assert.ok(sleeps.slice(0, 3).every((ms) => ms === HOST_BUSY_WAIT_MS), 'in host-busy steps');
  assert.equal(run.requests.length, 6);
  // Claims are bounded: one per job that ran, none per wait.
  assert.ok(claims <= 8, `claims were ${claims}`);
  const untouched = run.persistence.listJobs().filter((job) => job.key !== crashed.key);
  assert.ok(untouched.every((job) => job.attempts === 1), 'no job was claimed and settled while the host was held');
  assert.equal(before.length, 6);
});

test('a host-busy wait writes no job history', async () => {
  const run = harness([page()], { jobs: ['a', 'b'] });
  const holder = run.persistence.claimNextJob(run.clock(), 'holder');
  run.persistence.acquireRequest(holder.key, holder.lease, HOST);
  const other = run.persistence.listJobs().find((job) => job.key !== holder.key);
  const historyBefore = run.persistence.getJob(other.key).history.length;
  for (let wait = 0; wait < 5; wait += 1) {
    assert.equal((await run.orchestrator.runOnce('worker')).processed, 0);
    run.advance(1_000);
  }
  assert.equal(run.persistence.getJob(other.key).history.length, historyBefore);
  assert.equal(run.persistence.getJob(other.key).attempts, 0);
});

test('the fetcher still stops for a request another worker owns, uncharged, if the race is lost after the gate', async () => {
  const run = harness([page()], { jobs: ['a', 'b'] });
  const holder = run.persistence.claimNextJob(run.clock(), 'holder');
  run.persistence.acquireRequest(holder.key, holder.lease, HOST);
  const mine = run.persistence.claimNextJob(run.clock(), 'worker');
  const result = await run.fetcher.fetch(mine, mine.lease);
  assert.deepEqual([result.kind, result.reason, result.charge], ['retry_wait', 'host request already owned', undefined]);
  assert.equal(run.requests.length, 0);
});

// Bulk dispositions (#113).
function stoppedJobs(run, codes) {
  return codes.map((code, index) => {
    const job = run.persistence.claimNextJob(run.clock(), 'worker');
    run.persistence.transitionJob(job.key, 'operator_stop', job.lease, { lastError: `stopped for ${code}`, code });
    return { key: job.key, code, index };
  });
}

test('a review job summary carries the code of its latest stop', () => {
  const run = harness([page()], { jobs: ['a', 'b'] });
  const [capped, hard] = stoppedJobs(run, ['rate_limit_cap', 'response_too_large']);
  const summaries = new Map(run.persistence.reviewJobs({ states: ['operator_stop'] }).items.map((item) => [item.key, item.code]));
  assert.equal(summaries.get(capped.key), 'rate_limit_cap');
  assert.equal(summaries.get(hard.key), 'response_too_large');
});

test('one command releases every job stopped for a code, with a recorded disposition each', async () => {
  const run = harness([page()], { jobs: ['a', 'b', 'c', 'd'] });
  const stopped = stoppedJobs(run, ['rate_limit_cap', 'rate_limit_cap', 'challenge', 'rate_limit_cap']);
  const clock = run.clock.bind(run);
  const common = { persistence: run.persistence, action: 'release-retry', states: ['operator_stop'], code: 'rate_limit_cap', operatorId: 'ops', reason: 'the block is over', clock };

  const preview = await disposeMatching({ ...common, dryRun: true });
  assert.deepEqual([preview.matched, preview.disposed, preview.dryRun], [3, 0, true]);
  assert.equal(run.persistence.operatorDispositions.length, 0, 'a dry run records nothing');

  const done = await disposeMatching(common);
  assert.deepEqual([done.matched, done.disposed], [3, 3]);
  assert.equal(run.persistence.operatorDispositions.length, 3, 'one disposition per job');
  assert.ok(run.persistence.operatorDispositions.every((entry) => entry.kind === 'release_retry' && entry.operatorId === 'ops' && entry.reason === 'the block is over'));
  const states = Object.fromEntries(stopped.map((entry) => [entry.code + entry.index, run.persistence.getJob(entry.key).state]));
  assert.deepEqual(states, { rate_limit_cap0: 'retry_wait', rate_limit_cap1: 'retry_wait', challenge2: 'operator_stop', rate_limit_cap3: 'retry_wait' });
  assert.equal((await disposeMatching(common)).matched, 0, 'nothing is left to release');
});

test('a bulk release by an unauthorized operator stops at the first refusal and says how far it got', async () => {
  const run = harness([page()], { jobs: ['a', 'b'] });
  stoppedJobs(run, ['rate_limit_cap', 'rate_limit_cap']);
  await assert.rejects(disposeMatching({ persistence: run.persistence, action: 'release-retry', states: ['operator_stop'], code: 'rate_limit_cap',
    operatorId: 'intruder', reason: 'x', clock: run.clock }), /stopped after 0 of 2 jobs .* not authorized/);
  await assert.rejects(disposeMatching({ persistence: run.persistence, action: 'explode', states: ['operator_stop'], code: 'x', clock: run.clock }), /job action explode is invalid/);
});

test('the review command takes a bulk form and refuses an unbounded one', () => {
  const parsed = parseReviewArgs(['release-retry', '--state', 'operator_stop', '--code', 'rate_limit_cap', '--operator', 'ops', '--reason', 'block over', '--dry-run']);
  assert.deepEqual(parsed.bulk, { states: ['operator_stop'], code: 'rate_limit_cap', dryRun: true });
  assert.deepEqual([parsed.command, parsed.operatorId, parsed.reason], ['release-retry', 'ops', 'block over']);
  assert.throws(() => parseReviewArgs(['release-retry', '--state', 'operator_stop', '--operator', 'ops', '--reason', 'x']), /needs both --state and --code/);
  assert.throws(() => parseReviewArgs(['release-retry', '--code', 'rate_limit_cap', '--operator', 'ops', '--reason', 'x']), /needs both --state and --code/);
  assert.throws(() => parseReviewArgs(['release-retry', '--state', 'operator_stop', '--code', 'x']), /needs --operator/);
  assert.throws(() => parseReviewArgs(['release-retry', '--state', 'operator_stop', '--code', 'x', '--bogus', '1', '--operator', 'o', '--reason', 'r']), /argument --bogus is invalid/);
  // The single-job form is unchanged.
  assert.equal(parseReviewArgs(['release-retry', 'job-key', '--operator', 'ops', '--reason', 'x']).target, 'job-key');
});
