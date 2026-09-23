import test from 'node:test';
import assert from 'node:assert/strict';
import { createJob, createNormalizedPage, createSourceUrl, canonicalizeSourceUrl } from 'web-scraper-foundation/contracts';
import { InMemoryPersistence } from '../src/persistence/index.mjs';

function job(key, parentKey) {
  const sourceUrl = createSourceUrl('provider', `https://allowed.example/${key}`);
  return createJob({ key, parentKey, pageType: 'season', sourceUrl, canonicalPath: canonicalizeSourceUrl(sourceUrl) });
}

function mutableClock() {
  let milliseconds = Date.parse('2026-01-01T00:00:00.000Z');
  return {
    clock: () => new Date(milliseconds),
    advance: (amount) => { milliseconds += amount; },
  };
}

test('children cannot be claimed until their parent commits and reaches parsed', () => {
  const time = mutableClock();
  const persistence = new InMemoryPersistence(time.clock);
  persistence.addJob(job('parent'));
  persistence.addJob(job('child', 'parent'));
  const parent = persistence.claimNextJob(time.clock(), 'worker-a');

  assert.equal(parent.key, 'parent');
  assert.equal(persistence.claimNextJob(time.clock(), 'worker-b'), null);
  persistence.transitionJob(parent.key, 'fetched', parent.lease);
  assert.equal(persistence.claimNextJob(time.clock(), 'worker-b'), null);
  persistence.transitionJob(parent.key, 'parsed', parent.lease);
  assert.equal(persistence.claimNextJob(time.clock(), 'worker-b').key, 'child');
});

test('active request ownership blocks recovery until completion or confirmed cancellation', () => {
  const time = mutableClock();
  const persistence = new InMemoryPersistence(time.clock);
  persistence.addJob(job('owned'));
  const first = persistence.claimNextJob(time.clock(), 'worker-a');
  const request = persistence.acquireRequest(first.key, first.lease, first.sourceUrl.host);
  time.advance(60_000);

  assert.equal(persistence.recoverExpiredClaims(time.clock()), 0);
  assert.equal(persistence.claimNextJob(time.clock(), 'worker-b'), null);
  assert.throws(() => persistence.transitionJob(first.key, 'fetched', first.lease), /stale or missing lease/);

  const cancellation = persistence.confirmRequestCancellation(first.key, first.lease, 'worker process terminated and transport cancellation confirmed');
  assert.equal(cancellation.outcome, 'canceled');
  assert.equal(cancellation.providerId, 'provider');
  assert.equal(request.host, 'allowed.example');
  assert.equal(persistence.recoverExpiredClaims(time.clock()), 1);
  const replacement = persistence.claimNextJob(time.clock(), 'worker-b');
  assert.equal(replacement.lease.generation, 2);
  assert.throws(() => persistence.commitPage({ jobKey: first.key, identity: first.key, data: {} }, {}, first.lease), /stale or missing lease/);
});

test('commitPage rejects a page commit while its host request is still active', () => {
  const time = mutableClock();
  const persistence = new InMemoryPersistence(time.clock);
  persistence.addJob(job('active'));
  const claimed = persistence.claimNextJob(time.clock(), 'worker');
  persistence.acquireRequest(claimed.key, claimed.lease, claimed.sourceUrl.host);

  assert.throws(
    () => persistence.commitPage({ jobKey: claimed.key, identity: claimed.key, data: {} }, {}, claimed.lease),
    /host request is still active/,
  );

  persistence.releaseRequest(claimed.key, claimed.lease);
  assert.equal(persistence.commitPage({ jobKey: claimed.key, identity: claimed.key, data: {} }, {}, claimed.lease), claimed.key);
});

test('operator stops require an authorized reviewed disposition and never auto-retry', () => {
  const time = mutableClock();
  const persistence = new InMemoryPersistence(time.clock, { authorizeOperator: (operatorId) => operatorId === 'approved-operator' });
  persistence.addJob(job('challenge'));
  const claimed = persistence.claimNextJob(time.clock(), 'worker');
  persistence.transitionJob(claimed.key, 'operator_stop', claimed.lease, { lastError: 'challenge response' });

  assert.equal(persistence.claimNextJob(time.clock(), 'other-worker'), null);
  assert.throws(
    () => persistence.recordOperatorDisposition(claimed.key, { kind: 'release_retry', operatorId: 'intruder', reason: 'not reviewed' }),
    /not authorized/,
  );
  persistence.recordOperatorDisposition(claimed.key, { kind: 'hold', operatorId: 'approved-operator', reason: 'awaiting provider review' });
  assert.equal(persistence.getJob(claimed.key).state, 'operator_stop');
  assert.equal(persistence.claimNextJob(time.clock(), 'other-worker'), null);
  persistence.recordOperatorDisposition(claimed.key, { kind: 'release_retry', operatorId: 'approved-operator', reason: 'challenge cleared after review' });
  assert.equal(persistence.claimNextJob(time.clock(), 'other-worker').key, claimed.key);
});

test('failure history retains attempts timing warnings and details', () => {
  const time = mutableClock();
  const persistence = new InMemoryPersistence(time.clock);
  persistence.addJob(job('failure'));
  const claimed = persistence.claimNextJob(time.clock(), 'worker');
  persistence.transitionJob(claimed.key, 'parse_failed', claimed.lease, {
    failureReason: 'layout changed',
    warnings: ['unexpected heading'],
    parserVersion: '2',
  });
  const stored = persistence.getJob(claimed.key);

  assert.equal(stored.attempts, 1);
  assert.equal(stored.failures.length, 1);
  assert.equal(stored.failures[0].reason, 'layout changed');
  assert.deepEqual(stored.failures[0].details.warnings, ['unexpected heading']);
  assert.equal(stored.history.at(-1).to, 'parse_failed');
  assert.equal(stored.history.at(-1).leaseGeneration, 1);
});

test('crash recovery replays an idempotent page commit without duplicate work or facts', () => {
  const time = mutableClock();
  const persistence = new InMemoryPersistence(time.clock);
  persistence.addJob(job('parent'));
  const first = persistence.claimNextJob(time.clock(), 'worker-a');
  const page = createNormalizedPage({
    jobKey: first.key,
    kind: 'season',
    identity: 'season-record',
    data: { endingYear: 2026 },
    observations: [{ key: 'season-observation', kind: 'season', rowIndex: 0 }],
    childJobs: [job('child', first.key)],
  });
  persistence.transitionJob(first.key, 'fetched', first.lease);
  persistence.commitPage(page, { sourceFetchId: 'fetch-1' }, first.lease);

  time.advance(60_000);
  assert.equal(persistence.recoverExpiredClaims(time.clock()), 1);
  const resumed = persistence.claimNextJob(time.clock(), 'worker-b');
  persistence.transitionJob(resumed.key, 'fetched', resumed.lease);
  persistence.commitPage(page, { sourceFetchId: 'fetch-1' }, resumed.lease);
  persistence.transitionJob(resumed.key, 'parsed', resumed.lease);

  assert.equal(persistence.pages.size, 1);
  assert.equal(persistence.observations.size, 1);
  assert.equal(persistence.jobs.size, 2);
  assert.equal(persistence.claimNextJob(time.clock(), 'worker-b').key, 'child');
});
