import test from 'node:test';
import assert from 'node:assert/strict';
import { createSourceUrl, canonicalizeSourceUrl } from '../src/contracts/source.mjs';
import { REQUEST_POLICY_DEFAULTS, validateRequestPolicy } from '../src/contracts/request-policy.mjs';
import { Fetcher } from '../src/fetcher/index.mjs';
import { InMemoryPersistence, MemoryRawStore } from '../src/persistence/index.mjs';

// #130: a 404 or 410 on a published link is a charged retry on a long backoff.

const policy = { minIntervalMs: 6_000, maxRequestsPerMinute: 10, hostConcurrency: 1, userAgent: 'scraper (+ops@example.com)' };
const MINUTE = 60_000;

function setup(statuses, policyOverrides = {}) {
  let time = Date.parse('2026-01-01T00:00:00.000Z');
  const clock = () => new Date(time);
  const persistence = new InMemoryPersistence(clock);
  const sourceUrl = createSourceUrl('provider', 'https://allowed.example/page');
  persistence.addJob({ key: 'job', pageType: 'season', sourceUrl, canonicalPath: canonicalizeSourceUrl(sourceUrl) });
  const sequence = [...statuses];
  const transport = { async request() {
    const status = sequence.length > 1 ? sequence.shift() : sequence[0];
    return { status, headers: {}, body: status === 200 ? Buffer.from('<html></html>') : Buffer.alloc(0) };
  } };
  const fetcher = new Fetcher({ transport, rawStore: new MemoryRawStore(), persistence, clock, sleep: async (ms) => { time += ms; }, allowedHosts: ['allowed.example'], policy: { ...policy, ...policyOverrides } });
  return {
    fetcher, persistence, clock,
    advance: (ms) => { time += ms; },
    // One attempt: claim, fetch, and settle a retry the way the orchestrator does.
    async attempt() {
      const job = persistence.claimNextJob(clock(), 'worker');
      assert.ok(job, 'the job is claimable');
      const result = await fetcher.fetch(job, job.lease);
      if (result.kind === 'retry_wait') persistence.transitionJob(job.key, 'retry_wait', job.lease, { nextAllowedAt: result.nextAllowedAt, charge: result.charge });
      if (result.kind === 'permanently_failed') persistence.transitionJob(job.key, 'permanently_failed', job.lease, { lastError: result.reason });
      return result;
    },
  };
}

test('a page that returns 404 once and then succeeds is fetched', async () => {
  const run = setup([404, 200]);
  const first = await run.attempt();
  assert.equal(first.kind, 'retry_wait');
  assert.equal(first.code, 'not_found');
  assert.equal(first.charge, 'failure');
  assert.equal(first.reason, 'upstream 404');
  assert.equal(Date.parse(first.nextAllowedAt) - run.clock().getTime(), 15 * MINUTE);
  assert.equal(run.persistence.claimNextJob(run.clock(), 'worker'), null, 'not claimable before the backoff has passed');
  run.advance(15 * MINUTE);
  assert.equal((await run.attempt()).kind, 'fetched');
});

test('a page that keeps returning 404 or 410 fails permanently once the budget is spent', async () => {
  for (const status of [404, 410]) {
    const run = setup([status]);
    const delays = [];
    let result;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      result = await run.attempt();
      if (result.kind === 'retry_wait') { delays.push((Date.parse(result.nextAllowedAt) - run.clock().getTime()) / MINUTE); run.advance(Date.parse(result.nextAllowedAt) - run.clock().getTime()); }
    }
    assert.deepEqual(delays, [15, 30], `${status}: the backoff doubles`);
    assert.equal(result.kind, 'permanently_failed');
    assert.equal(result.code, 'not_found');
    assert.equal(result.reason, `upstream ${status}; retry limit reached`);
    assert.equal(run.persistence.getJob('job').state, 'permanently_failed');
  }
});

test('the not-found backoff is capped and follows maxAttempts', async () => {
  const run = setup([404], { maxAttempts: 5, notFoundRetryBaseMs: 15 * MINUTE, notFoundRetryMaxMs: 30 * MINUTE });
  const delays = [];
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const result = await run.attempt();
    assert.equal(result.kind, 'retry_wait');
    delays.push((Date.parse(result.nextAllowedAt) - run.clock().getTime()) / MINUTE);
    run.advance(Date.parse(result.nextAllowedAt) - run.clock().getTime());
  }
  assert.deepEqual(delays, [15, 30, 30, 30]);
  assert.equal((await run.attempt()).kind, 'permanently_failed');
});

test('other 4xx responses still fail permanently on the first response', async () => {
  for (const status of [400, 401, 405, 451]) {
    const run = setup([status]);
    const result = await run.attempt();
    assert.equal(result.kind, 'permanently_failed', String(status));
    assert.equal(result.reason, `upstream ${status}`);
  }
});

test('the not-found backoff settings are validated', () => {
  const valid = { ...policy };
  assert.equal(validateRequestPolicy(valid).notFoundRetryBaseMs, REQUEST_POLICY_DEFAULTS.notFoundRetryBaseMs);
  assert.throws(() => validateRequestPolicy({ ...valid, notFoundRetryBaseMs: 10 }), /policy\.notFoundRetryBaseMs/);
  assert.throws(() => validateRequestPolicy({ ...valid, notFoundRetryMaxMs: 999_999_999 }), /policy\.notFoundRetryMaxMs/);
  assert.throws(() => validateRequestPolicy({ ...valid, notFoundRetryBaseMs: 3_600_000, notFoundRetryMaxMs: 60_000 }), /at least policy\.notFoundRetryBaseMs/);
});
