import test from 'node:test';
import assert from 'node:assert/strict';
import { createJob } from '../src/contracts/boundaries.mjs';
import { ORPHANED_REQUEST_REASON } from '../src/contracts/jobs.mjs';
import { createSourceUrl, canonicalizeSourceUrl } from '../src/contracts/source.mjs';
import { InMemoryPersistence } from '../src/persistence/index.mjs';

const CLAIM_MS = 10_000;
const REQUEST_MS = 30_000;
const GRACE_MS = 5_000;
const HOST = 'allowed.example';

function job(path) {
  const sourceUrl = createSourceUrl('provider', `https://${HOST}/${path}`);
  return createJob({ key: `provider:${HOST}/${path}:season`, pageType: 'season', sourceUrl, canonicalPath: canonicalizeSourceUrl(sourceUrl) });
}

function store() {
  let milliseconds = Date.parse('2026-01-01T00:00:00.000Z');
  const clock = () => new Date(milliseconds);
  const persistence = new InMemoryPersistence(clock, { claimTimeoutMs: CLAIM_MS, requestTimeoutMs: REQUEST_MS, orphanGraceMs: GRACE_MS });
  persistence.addJob(job('crashed'));
  persistence.addJob(job('waiting'));
  return { persistence, clock, advance: (ms) => { milliseconds += ms; } };
}

test('a request left behind by a crashed worker is released after the deadline and its job recovers with no manual step', () => {
  const { persistence, clock, advance } = store();
  const crashed = persistence.claimNextJob(clock(), 'crashed-worker');
  assert.ok(persistence.acquireRequest(crashed.key, crashed.lease, HOST));
  // The worker renews once mid-request, then dies.
  advance(5_000);
  persistence.renewClaim(crashed.key, crashed.lease);
  const leaseExpiry = Date.parse(persistence.getJob(crashed.key).claim.expiresAt);

  const other = persistence.claimNextJob(clock(), 'other-worker');
  assert.equal(other.key, job('waiting').key);
  advance(leaseExpiry + REQUEST_MS + GRACE_MS - clock().getTime());
  // Exactly at the deadline the request may still be running: never released early.
  assert.equal(persistence.releaseOrphanedRequests(), 0);
  persistence.recoverExpiredClaims(); // recovers only the other worker's expired claim
  assert.equal(persistence.getJob(other.key).state, 'retry_wait');
  assert.equal(persistence.getJob(crashed.key).state, 'fetching');
  assert.ok(persistence.inFlight.has(crashed.key));

  advance(1);
  assert.equal(persistence.recoverExpiredClaims(), 1);
  const canceled = persistence.requestHistory.at(-1);
  assert.deepEqual([canceled.jobKey, canceled.outcome, canceled.cancellationReason], [crashed.key, 'canceled', ORPHANED_REQUEST_REASON]);
  const recovered = persistence.getJob(crashed.key);
  assert.equal(recovered.state, 'retry_wait');
  assert.equal(recovered.claimRecoveries, 1);
  assert.equal(recovered.failureAttempts, 0);
  // The host is free again; the recovered job can be claimed and fetched later.
  const retry = persistence.claimNextJob(clock(), 'third-worker');
  assert.equal(retry.key, crashed.key);
  assert.ok(persistence.acquireRequest(retry.key, retry.lease, HOST));
  assert.throws(() => persistence.releaseRequest(crashed.key, crashed.lease), /ownership mismatch/);
});

test('a request whose worker keeps renewing its lease is never released, however long it has been open', () => {
  const { persistence, clock, advance } = store();
  const live = persistence.claimNextJob(clock(), 'live-worker');
  assert.ok(persistence.acquireRequest(live.key, live.lease, HOST));
  for (let elapsed = 0; elapsed < 4 * (REQUEST_MS + GRACE_MS); elapsed += CLAIM_MS / 3) {
    advance(CLAIM_MS / 3);
    persistence.renewClaim(live.key, live.lease);
    assert.equal(persistence.recoverExpiredClaims(), 0);
  }
  assert.equal(persistence.inFlight.size, 1);
  const other = persistence.claimNextJob(clock(), 'other-worker');
  assert.equal(persistence.acquireRequest(other.key, other.lease, HOST), null);
  persistence.releaseRequest(live.key, live.lease);
  assert.equal(persistence.requestHistory.at(-1).outcome, 'completed');
});
