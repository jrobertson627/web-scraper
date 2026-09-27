import test from 'node:test';
import assert from 'node:assert/strict';
import { createJob } from '../src/contracts/boundaries.mjs';
import { createSourceUrl, canonicalizeSourceUrl } from '../src/contracts/source.mjs';
import { InMemoryPersistence } from '../src/persistence/index.mjs';
import { createFixtureApplication } from '../src/application/composition-root.mjs';

const HOUR = 3_600_000;

// The persistence clock stands in for the database clock; the worker's clock
// is skewed from it by a fixed amount.
function skewedClocks(skewMs) {
  let milliseconds = Date.parse('2026-01-01T00:00:00.000Z');
  return {
    store: () => new Date(milliseconds),
    worker: () => new Date(milliseconds + skewMs),
    advance: (amount) => { milliseconds += amount; },
  };
}

function job() {
  const sourceUrl = createSourceUrl('provider', 'https://allowed.example/page');
  return createJob({ key: 'provider:allowed.example/page:season', pageType: 'season', sourceUrl, canonicalPath: canonicalizeSourceUrl(sourceUrl) });
}

for (const skewMs of [HOUR, -HOUR]) {
  test(`a worker clock ${skewMs > 0 ? 'ahead of' : 'behind'} the store clock neither rejects a valid lease nor accepts an expired one`, () => {
    const time = skewedClocks(skewMs);
    const persistence = new InMemoryPersistence(time.store, { claimTimeoutMs: 10_000 });
    persistence.addJob(job());
    const claimed = persistence.claimNextJob(time.worker(), 'worker');
    assert.equal(claimed.claim.expiresAt, new Date(time.store().getTime() + 10_000).toISOString());

    time.advance(9_000);
    persistence.renewClaim(claimed.key, claimed.lease, time.worker());
    time.advance(9_000);
    persistence.transitionJob(claimed.key, 'fetched', claimed.lease);
    assert.equal(persistence.recoverExpiredClaims(time.worker()), 0);

    time.advance(1_001);
    assert.throws(() => persistence.transitionJob(claimed.key, 'parsed', claimed.lease), /stale or missing lease/);
    assert.throws(() => persistence.renewClaim(claimed.key, claimed.lease, new Date(0)), /stale or missing lease/);
    assert.equal(persistence.recoverExpiredClaims(new Date(0)), 1);
  });

  test(`a full fixture crawl completes when the worker clock is ${skewMs > 0 ? 'ahead of' : 'behind'} the store clock`, async () => {
    const time = skewedClocks(skewMs);
    const persistence = new InMemoryPersistence(time.store, { claimTimeoutMs: 30_000 });
    const app = createFixtureApplication({ sharedState: { clock: time.worker, sleep: async (ms) => time.advance(ms), persistence } });
    await app.runWorkerOnce();
    const jobs = persistence.listJobs();
    assert.ok(jobs.length > 1);
    assert.deepEqual([...new Set(jobs.map((entry) => entry.state))], ['parsed']);
  });
}
