import test from 'node:test';
import assert from 'node:assert/strict';
import { isTransientStoreError } from '../src/contracts/jobs.mjs';
import { InMemoryPersistence } from '../src/persistence/index.mjs';
import { createFixtureApplication } from '../src/application/composition-root.mjs';

function databaseError(code, message = `simulated ${code}`) { return Object.assign(new Error(message), { code }); }

// Fails the first page commit for one page type with the given error.
class FailingCommitPersistence extends InMemoryPersistence {
  constructor(clock, pageType, error) { super(clock, { claimTimeoutMs: 30_000 }); this.pageType = pageType; this.error = error; this.failures = 0; }
  commitPageAndTransition(page, provenance, lease) {
    if (!this.failures && page.jobKey.endsWith(`:${this.pageType}`)) { this.failures += 1; throw this.error; }
    return super.commitPageAndTransition(page, provenance, lease);
  }
}

function crawl(error, pageType = 'school_history') {
  let milliseconds = Date.parse('2026-01-01T00:00:00.000Z');
  const clock = () => new Date(milliseconds);
  const persistence = new FailingCommitPersistence(clock, pageType, error);
  const app = createFixtureApplication({ sharedState: { clock, sleep: async (ms) => { milliseconds += ms; }, persistence } });
  return { app, persistence, advance: (ms) => { milliseconds += ms; } };
}

test('PostgreSQL serialization, deadlock, connection and shutdown errors are transient; structural errors are not', () => {
  for (const code of ['40001', '40P01', '08000', '08003', '08006', '57P01', 'ECONNRESET']) assert.equal(isTransientStoreError(databaseError(code)), true, code);
  assert.equal(isTransientStoreError(new Error('Connection terminated unexpectedly')), true);
  assert.equal(isTransientStoreError(new Error('wrapped', { cause: databaseError('40P01') })), true);
  for (const code of ['23505', '23514', '42P01', '57014', undefined]) assert.equal(isTransientStoreError(databaseError(code)), false, String(code));
  assert.equal(isTransientStoreError(new Error('school history has no stored school identity')), false);
});

for (const [label, error] of [
  ['deadlock', databaseError('40P01', 'deadlock detected')],
  ['connection reset', databaseError('08006', 'connection failure during commit')],
  ['dropped socket', new Error('Connection terminated unexpectedly')],
]) {
  test(`a ${label} during commit leaves the job retryable and it completes on retry, not parse_failed`, async () => {
    const { app, persistence, advance } = crawl(error);
    const result = await app.runWorkerOnce();
    const retry = result.events.find((event) => event.pageType === 'school_history' && event.kind === 'retry_wait');
    assert.ok(retry, 'the failed commit became a retry');
    assert.equal(retry.phase, 'commit');
    assert.equal(persistence.listJobs().find((job) => job.pageType === 'school_history').state, 'retry_wait');
    advance(60_000);
    await app.runWorkerOnce();
    const jobs = persistence.listJobs();
    assert.deepEqual([...new Set(jobs.map((job) => job.state))], ['parsed']);
    const history = jobs.find((job) => job.pageType === 'school_history');
    assert.equal(history.failures.some((failure) => failure.state === 'parse_failed'), false);
    assert.equal(history.failureAttempts, 1);
    assert.equal(persistence.pages.has(history.key), true);
  });
}

test('a structural normalizer error still becomes parse_failed', async () => {
  const { app, persistence } = crawl(new Error('school history has no stored school identity'));
  const result = await app.runWorkerOnce();
  assert.equal(result.events.find((event) => event.pageType === 'school_history').kind, 'parse_failed');
  assert.equal(persistence.listJobs().find((job) => job.pageType === 'school_history').state, 'parse_failed');
});
