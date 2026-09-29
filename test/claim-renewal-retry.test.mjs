import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createSourceUrl, canonicalizeSourceUrl } from '../src/contracts/source.mjs';
import { Fetcher } from '../src/fetcher/index.mjs';
import { InMemoryPersistence, MemoryRawStore } from '../src/persistence/index.mjs';

// #127: a claim renewal that fails while a request is on the wire must not, on
// its own, discard a good response.

const policy = { minIntervalMs: 6_000, maxRequestsPerMinute: 10, hostConcurrency: 1, userAgent: 'scraper (+ops@example.com)' };

// The claim lasts 600 ms, so the renewal timer (every max(50, claimTimeoutMs / 3)
// = 200 ms) fires several times during a request that takes `requestMs` of real time.
// The margins are generous because these run against real timers on shared CI.
function setup({ requestMs = 900, renew } = {}) {
  const clock = () => new Date();
  const persistence = new InMemoryPersistence(clock, { claimTimeoutMs: 600 });
  const rawStore = new MemoryRawStore();
  const sourceUrl = createSourceUrl('provider', 'https://allowed.example/page');
  persistence.addJob({ key: 'job', pageType: 'season', sourceUrl, canonicalPath: canonicalizeSourceUrl(sourceUrl) });
  const renewals = { calls: 0 };
  const realRenew = persistence.renewClaim.bind(persistence);
  persistence.renewClaim = (key, lease, now) => {
    renewals.calls += 1;
    renew?.(renewals.calls);
    return realRenew(key, lease, now);
  };
  const transport = { async request() { await delay(requestMs); return { status: 200, headers: {}, body: Buffer.from('<html></html>') }; } };
  const fetcher = new Fetcher({ transport, rawStore, persistence, clock, sleep: async () => {}, allowedHosts: ['allowed.example'], policy });
  return { fetcher, persistence, renewals, claim: () => persistence.claimNextJob(clock(), 'worker') };
}

test('a single failed renewal, with the claim still valid, does not discard the response', async () => {
  const run = setup({ renew: (call) => { if (call === 3) throw new Error('database is unavailable'); } });
  const claimed = await run.claim();
  const result = await run.fetcher.fetch(claimed, claimed.lease);
  assert.equal(result.kind, 'fetched');
  assert.ok(run.renewals.calls >= 5, 'renewal kept running after the failure');
  assert.equal(run.persistence.getJob('job').claim.owner, 'worker', 'the claim is still held');
});

test('a renewal that failed on the last tick is retried when the request ends', async () => {
  // Renewal calls: the initial one (1), then ticks at 200, 400 and 600 ms (2, 3, 4).
  // The 600 ms tick fails and no tick follows before the request ends at 700 ms.
  const run = setup({ requestMs: 700, renew: (call) => { if (call === 4) throw new Error('database is unavailable'); } });
  const claimed = await run.claim();
  const result = await run.fetcher.fetch(claimed, claimed.lease);
  assert.equal(result.kind, 'fetched', 'the end-of-request renewal succeeded, so the response is kept');
  assert.equal(run.renewals.calls, 5, 'the failed tick was retried once when the request ended');
});

test('a claim that cannot be renewed at the end still discards the response', async () => {
  const run = setup({ renew: (call) => { if (call > 1) throw new Error('stale or missing lease for job job'); } });
  const claimed = await run.claim();
  await assert.rejects(run.fetcher.fetch(claimed, claimed.lease), (error) => error.code === 'lease_renewal_failed' && /claim renewal failed/.test(error.message));
});

test('a transport error with a healthy claim is reported as the transport error', async () => {
  const run = setup();
  run.fetcher.transport = { async request() { await delay(60); throw Object.assign(new Error('socket reset'), { code: 'transient_network' }); } };
  const claimed = await run.claim();
  const result = await run.fetcher.fetch(claimed, claimed.lease);
  assert.equal(result.kind, 'retry_wait');
  assert.equal(result.code, 'transient_network');
});

test('a transport error while the claim is lost reports the lost claim', async () => {
  const run = setup({ renew: (call) => { if (call > 1) throw new Error('stale or missing lease for job job'); } });
  run.fetcher.transport = { async request() { await delay(700); throw Object.assign(new Error('socket reset'), { code: 'transient_network' }); } };
  const claimed = await run.claim();
  await assert.rejects(run.fetcher.fetch(claimed, claimed.lease), (error) => error.code === 'lease_renewal_failed');
});
