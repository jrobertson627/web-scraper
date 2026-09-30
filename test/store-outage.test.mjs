import test from 'node:test';
import assert from 'node:assert/strict';
import { createJob } from '../src/contracts/boundaries.mjs';
import { canonicalizeSourceUrl, createSourceUrl } from '../src/contracts/source.mjs';
import { InMemoryPersistence } from '../src/persistence/index.mjs';
import { IngestionOrchestrator } from '../src/application/orchestrator.mjs';

// #122: a short database outage pauses the run, which then continues without a
// restart; out of disk or memory halts it; anything else still ends it.

const databaseError = (code) => Object.assign(new Error(`simulated ${code}`), { code });

function harness({ storeRetry } = {}) {
  let now = Date.parse('2026-01-01T00:00:00.000Z');
  const clock = () => new Date(now);
  const persistence = new InMemoryPersistence(clock, { claimTimeoutMs: 30_000 });
  const fetched = [];
  const fetcher = { policy: undefined, allowedHosts: [], async fetch(job) { fetched.push(job.key); return { kind: 'permanently_failed', reason: 'gone' }; } };
  const sourceUrl = createSourceUrl('provider', 'https://allowed.example/a');
  persistence.addJob(createJob({ key: 'provider:allowed.example/a:season', pageType: 'season', sourceUrl, canonicalPath: canonicalizeSourceUrl(sourceUrl) }));
  const events = [];
  const orchestrator = new IngestionOrchestrator({
    fetcher, discovery: {}, parsers: {}, normalizer: {}, persistence, rawStore: {}, clock,
    events: { emit: (name, fields) => events.push([name, fields]) }, ...(storeRetry ? { storeRetry } : {}),
  });
  const sleeps = [];
  return { persistence, orchestrator, fetched, events, sleeps, sleep: async (ms) => { sleeps.push(ms); now += ms; } };
}

// Makes a persistence method fail `times` times with `error`, then work.
function failing(persistence, method, error, times) {
  const original = persistence[method].bind(persistence);
  let remaining = times;
  const calls = { count: 0 };
  persistence[method] = (...args) => {
    calls.count += 1;
    if (remaining > 0) { remaining -= 1; throw error; }
    return original(...args);
  };
  return calls;
}

for (const method of ['claimNextJob', 'workOutlook', 'unreviewedChallenges']) {
  test(`a short outage from ${method} pauses the run, which then continues without a restart`, async () => {
    const run = harness();
    const calls = failing(run.persistence, method, databaseError('57P03'), 3);
    const result = await run.orchestrator.run({ workerId: 'worker', sleep: run.sleep, maxIdleMs: 1, minIdleMs: 1 });
    assert.equal(result.halt, undefined);
    assert.equal(result.stopped, false);
    assert.deepEqual(run.fetched, ['provider:allowed.example/a:season'], 'the job was crawled after the outage');
    assert.deepEqual(run.sleeps.slice(0, 3), [1_000, 2_000, 4_000], 'the wait backs off');
    assert.equal(run.events.filter(([name]) => name === 'store.retrying').length, 3);
    assert.ok(calls.count >= 4);
  });
}

test('a statement timeout and too many connections are waited out like a dropped connection', async () => {
  for (const code of ['57014', '53300', '08006', '40001']) {
    const run = harness();
    failing(run.persistence, 'claimNextJob', databaseError(code), 1);
    const result = await run.orchestrator.run({ workerId: 'worker', sleep: run.sleep });
    assert.equal(result.halt, undefined, code);
    assert.deepEqual(run.fetched.length, 1, code);
  }
});

test('the wait is bounded: after the configured tries the database error ends the run', async () => {
  const run = harness({ storeRetry: { attempts: 4, baseMs: 100, maxMs: 250 } });
  failing(run.persistence, 'claimNextJob', databaseError('57P03'), 99);
  await assert.rejects(run.orchestrator.run({ workerId: 'worker', sleep: run.sleep }), (error) => error.code === '57P03');
  assert.deepEqual(run.sleeps, [100, 200, 250], 'three waits between four tries, capped');
  assert.deepEqual(run.fetched, []);
});

test('an error that is not transient is not retried', async () => {
  const run = harness();
  failing(run.persistence, 'claimNextJob', databaseError('42P01'), 99);
  await assert.rejects(run.orchestrator.run({ workerId: 'worker', sleep: run.sleep }), (error) => error.code === '42P01');
  assert.deepEqual(run.sleeps, []);
});

test('the database running out of disk halts the run instead of being retried', async () => {
  for (const method of ['claimNextJob', 'workOutlook', 'unreviewedChallenges']) {
    const run = harness();
    failing(run.persistence, method, databaseError('53100'), 99);
    const result = await run.orchestrator.run({ workerId: 'worker', sleep: run.sleep });
    assert.deepEqual([result.stopped, result.stopReason, result.halt.reason, result.halt.awaitingReview], [true, 'database_storage_full', 'database_storage_full', 0], method);
    assert.match(result.halt.detail, /out of disk or memory \(53100\)/);
    assert.deepEqual(run.sleeps, [], 'no waiting for something waiting cannot fix');
    assert.deepEqual(run.events.filter(([name]) => name === 'run.halted').map(([, fields]) => fields.reason), ['database_storage_full'], 'the halt is logged like any other');
  }
});

test('a page commit that hits the database running out of resources is put back uncharged and halts the run', async () => {
  const run = harness();
  const good = { kind: 'fetched', sourceFetchId: 'fetch-1', checksum: 'a'.repeat(64), body: Buffer.from('{}') };
  run.orchestrator.fetcher.fetch = async () => good;
  run.orchestrator.parsers = { get: () => ({ version: () => '1' }), parse: () => { throw databaseError('53100'); } };
  const result = await run.orchestrator.run({ workerId: 'worker', sleep: run.sleep });
  assert.equal(result.halt.reason, 'database_storage_full');
  const job = run.persistence.getJob('provider:allowed.example/a:season');
  assert.equal(job.state, 'retry_wait', 'not parse_failed');
  assert.equal(job.failureAttempts ?? 0, 0, 'not charged');
});

test('runOnce reports the same halt instead of throwing', async () => {
  const run = harness();
  const good = { kind: 'fetched', sourceFetchId: 'fetch-1', checksum: 'a'.repeat(64), body: Buffer.from('{}') };
  run.orchestrator.fetcher.fetch = async () => good;
  run.orchestrator.parsers = { get: () => ({ version: () => '1' }), parse: () => { throw databaseError('53200'); } };
  const result = await run.orchestrator.runOnce('worker');
  assert.equal(result.halt.reason, 'database_storage_full');
});
