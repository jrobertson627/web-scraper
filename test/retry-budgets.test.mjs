import test from 'node:test';
import assert from 'node:assert/strict';
import { createJob } from '../src/contracts/boundaries.mjs';
import { createSourceUrl, canonicalizeSourceUrl } from '../src/contracts/source.mjs';
import { validateRequestPolicy } from '../src/contracts/request-policy.mjs';
import { Fetcher } from '../src/fetcher/index.mjs';
import { InMemoryPersistence, MemoryRawStore } from '../src/persistence/index.mjs';
import { IngestionOrchestrator } from '../src/application/orchestrator.mjs';

const RATE_LIMITED = { status: 429, headers: { 'retry-after': '0' }, body: Buffer.alloc(0) };
const UNAVAILABLE = { status: 503, headers: {}, body: Buffer.alloc(0) };
const TERMINAL = new Set(['permanently_failed', 'operator_stop', 'parsed', 'parse_failed']);

function job(path) {
  const sourceUrl = createSourceUrl('provider', `https://allowed.example/${path}`);
  return createJob({ key: `provider:allowed.example/${path}:season`, pageType: 'season', sourceUrl, canonicalPath: canonicalizeSourceUrl(sourceUrl) });
}

// A worker whose transport answers from a script; the last answer repeats.
function harness(responses, policy = {}) {
  let milliseconds = Date.parse('2026-01-01T00:00:00.000Z');
  const clock = () => new Date(milliseconds);
  const persistence = new InMemoryPersistence(clock, { claimTimeoutMs: 30_000 });
  const rawStore = new MemoryRawStore();
  const transport = { calls: 0, async request() { return responses[Math.min(this.calls++, responses.length - 1)]; } };
  const fetcher = new Fetcher({ transport, rawStore, persistence, clock, sleep: async (ms) => { milliseconds += ms; },
    allowedHosts: ['allowed.example'],
    policy: { minIntervalMs: 6_000, maxRequestsPerMinute: 10, hostConcurrency: 1, userAgent: 'scraper (+ops@example.com)', ...policy } });
  const orchestrator = new IngestionOrchestrator({ fetcher, discovery: {}, parsers: {}, normalizer: {}, persistence, rawStore, clock });
  const target = job('target');
  persistence.addJob(target);
  return {
    persistence, transport, clock, target, orchestrator,
    advance: (ms) => { milliseconds += ms; },
    // Runs the worker, waiting out each retry, until the job settles.
    async settle(limit = 50) {
      const events = [];
      for (let run = 0; run < limit; run += 1) {
        events.push(...(await orchestrator.runOnce('worker')).events);
        const current = persistence.getJob(target.key);
        if (TERMINAL.has(current.state)) return events;
        if (current.state === 'retry_wait') milliseconds = Math.max(milliseconds, Date.parse(current.nextAllowedAt));
      }
      throw new Error('job did not settle');
    },
  };
}

test('repeated 429s with Retry-After reach operator_stop at the configured rate-limit cap', async () => {
  const run = harness([RATE_LIMITED], { maxRateLimitAttempts: 4 });
  const events = await run.settle();
  const stopped = run.persistence.getJob(run.target.key);
  assert.equal(stopped.state, 'operator_stop');
  assert.equal(run.transport.calls, 4);
  assert.equal(stopped.rateLimitAttempts, 3);
  assert.equal(stopped.failureAttempts, 0);
  assert.equal(events.at(-1).code, 'rate_limit_cap');
  assert.match(stopped.lastError, /rate limited 4 times; operator review required/);
  assert.equal(validateRequestPolicy({ minIntervalMs: 6_000, maxRequestsPerMinute: 10, hostConcurrency: 1, userAgent: 'scraper (+ops@example.com)' }).maxRateLimitAttempts, 5);
  assert.throws(() => validateRequestPolicy({ minIntervalMs: 6_000, maxRequestsPerMinute: 10, hostConcurrency: 1, userAgent: 'scraper (+ops@example.com)', maxRateLimitAttempts: 0 }), /maxRateLimitAttempts/);
});

test('an operator release gives a rate-limited job a fresh 429 budget', async () => {
  const run = harness([RATE_LIMITED], { maxRateLimitAttempts: 2 });
  await run.settle();
  assert.equal(run.persistence.getJob(run.target.key).state, 'operator_stop');
  run.persistence.recordOperatorDisposition(run.target.key, { kind: 'release_retry', operatorId: 'ops', reason: 'provider asked us to resume' });
  assert.equal(run.persistence.getJob(run.target.key).rateLimitAttempts, 0);
  await run.settle();
  assert.equal(run.transport.calls, 4);
});

test('429s do not spend the transport and 5xx budget', async () => {
  const run = harness([RATE_LIMITED, RATE_LIMITED, RATE_LIMITED, UNAVAILABLE], { maxAttempts: 3 });
  const events = await run.settle();
  const failed = run.persistence.getJob(run.target.key);
  assert.equal(failed.state, 'permanently_failed');
  assert.equal(run.transport.calls, 3 + 3);
  assert.deepEqual(events.map((event) => event.kind),
    ['retry_wait', 'retry_wait', 'retry_wait', 'retry_wait', 'retry_wait', 'permanently_failed']);
  assert.equal(failed.rateLimitAttempts, 3);
  assert.equal(failed.failureAttempts, 2);
  assert.match(failed.lastError, /upstream 503; retry limit reached/);
});

test('host-busy retries do not reduce the attempts left for transport and 5xx errors', async () => {
  const run = harness([UNAVAILABLE], { maxAttempts: 3 });
  const blocker = job('blocker');
  run.persistence.addJob(blocker);
  // Another job owns the host, so every claim of the target finds it busy.
  const target = run.persistence.claimNextJob(run.clock(), 'first');
  run.persistence.transitionJob(target.key, 'retry_wait', target.lease, { nextAllowedAt: new Date(run.clock().getTime() + 1_000).toISOString() });
  const held = run.persistence.claimNextJob(run.clock(), 'holder');
  assert.equal(held.key, blocker.key);
  run.persistence.acquireRequest(blocker.key, held.lease, 'allowed.example');
  run.advance(1_000);
  for (let busy = 0; busy < 5; busy += 1) {
    const { events } = await run.orchestrator.runOnce('worker');
    assert.equal(events[0].reason, 'host request already owned');
    run.advance(1_000);
  }
  assert.equal(run.persistence.getJob(run.target.key).failureAttempts, 0);
  assert.equal(run.transport.calls, 0);
  run.persistence.releaseRequest(blocker.key, held.lease);

  await run.settle();
  const failed = run.persistence.getJob(run.target.key);
  assert.equal(failed.state, 'permanently_failed');
  assert.equal(run.transport.calls, 3);
  assert.equal(failed.failureAttempts, 2);
  assert.ok(failed.attempts >= 8);
});
