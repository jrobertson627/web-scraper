import test from 'node:test';
import assert from 'node:assert/strict';
import { createFixtureApplication } from '../src/application/composition-root.mjs';
import { IngestionOrchestrator } from '../src/application/orchestrator.mjs';
import { EXIT_CODES, runCli } from '../src/application/cli.mjs';
import { createCrawlLog } from '../src/application/crawl-log.mjs';
import { createOperatorServer } from '../src/application/operator-server.mjs';
import { seasonDocument } from '../src/application/fixture-documents.mjs';
import { createFetchResult, createJob, createNormalizedPage } from '../src/contracts/boundaries.mjs';
import { canonicalizeSourceUrl, createSourceUrl } from '../src/contracts/source.mjs';
import { FixtureParser, ParserRegistry } from '../src/parsers/index.mjs';
import { InMemoryPersistence, MemoryRawStore } from '../src/persistence/index.mjs';

const BODY = Buffer.from(JSON.stringify(seasonDocument({ school: 'Fixture A', endingYear: 2026, gameLogUrl: null })));

// Each job's fetch outcome, in queue order: a challenge, a 429, a 5xx, a
// rate-limit cap (another operator_stop), or a page.
const OUTCOMES = {
  challenge: () => createFetchResult({ kind: 'operator_stop', code: 'challenge', reason: 'operator review required for challenge response' }),
  rateLimited: () => createFetchResult({ kind: 'retry_wait', reason: 'rate limited', nextAllowedAt: '2099-01-01T00:00:00.000Z', charge: 'rate_limit' }),
  serverError: () => createFetchResult({ kind: 'retry_wait', code: 'upstream_5xx', reason: 'upstream 503', nextAllowedAt: '2099-01-01T00:00:00.000Z', charge: 'failure' }),
  rateLimitCap: () => createFetchResult({ kind: 'operator_stop', code: 'rate_limit_cap', reason: 'rate limited 5 times; operator review required' }),
  invalidRetryAfter: () => createFetchResult({ kind: 'operator_stop', code: 'invalid_retry_after', reason: 'rate limited without valid Retry-After; operator review required' }),
  retryAfterTooLong: () => createFetchResult({ kind: 'operator_stop', code: 'retry_after_too_long', reason: 'Retry-After exceeds the configured maximum; operator review required' }),
  hardStop: () => createFetchResult({ kind: 'operator_stop', code: 'response_too_large', reason: 'response body exceeds the configured byte limit' }),
  page: () => createFetchResult({ kind: 'fetched', sourceFetchId: 'fetch-1', checksum: 'a'.repeat(64), body: Buffer.from(BODY) }),
};

function crawl(outcomes, { persistence } = {}) {
  const now = new Date('2026-01-01T00:00:00.000Z');
  const store = persistence ?? new InMemoryPersistence(() => now, { authorizeOperator: (operatorId) => operatorId === 'ops' });
  const events = [];
  const fetched = [];
  const plan = new Map();
  for (const [index, outcome] of outcomes.entries()) {
    const key = `job-${index}-${outcome}`;
    const sourceUrl = createSourceUrl('provider', `https://allowed.example/${key}.html`);
    store.addJob(createJob({ key, pageType: 'season', sourceUrl, canonicalPath: canonicalizeSourceUrl(sourceUrl) }));
    plan.set(key, [outcome]);
  }
  const orchestrator = new IngestionOrchestrator({
    fetcher: { fetch: async (job) => { fetched.push(job.key); const queue = plan.get(job.key); return OUTCOMES[queue.length > 1 ? queue.shift() : queue[0]](); } },
    parsers: new ParserRegistry().register(new FixtureParser('season')),
    discovery: { discover: () => ({ observations: [], childJobs: [], unavailableCoverage: [], warnings: [] }) },
    normalizer: { normalize: (pageType, document, context) => createNormalizedPage({ jobKey: context.jobKey, kind: pageType, identity: context.jobKey, data: document }) },
    persistence: store, rawStore: new MemoryRawStore(), clock: () => now,
    events: { emit: (name, fields) => events.push([name, fields]) },
  });
  const run = () => orchestrator.run({ workerId: 'worker', sleep: async () => { throw new Error('the test run never idles'); } });
  return { store, orchestrator, run, events, fetched, plan, keys: [...plan.keys()] };
}

test('the first challenge halts the run; later pages stay queued and no further request is made', async () => {
  const run = crawl(['challenge', 'page', 'page']);
  const result = await run.run();
  assert.deepEqual(run.fetched, [run.keys[0]], 'nothing is fetched after the challenge');
  assert.equal(result.stopped, true);
  assert.equal(result.stopReason, 'challenge');
  assert.deepEqual(result.halt, { reason: 'challenge', jobKey: run.keys[0], pageType: 'season', awaitingReview: 1 });
  assert.deepEqual(result.counts, { operator_stop: 1, pending: 2 });
  assert.deepEqual(run.events.filter(([name]) => name === 'run.halted').map(([, fields]) => fields.jobKey), [run.keys[0]]);
  assert.equal(run.store.getJob(run.keys[0]).history.at(-1).details.code, 'challenge', 'the stop code is recorded');
  assert.deepEqual(run.store.unreviewedChallenges().map(({ jobKey, code, url }) => [jobKey, code, url]),
    [[run.keys[0], 'challenge', `https://allowed.example/${run.keys[0]}.html`]]);
});

test('a later run makes no request while the challenge awaits review, and resumes once an operator holds or releases it', async () => {
  const run = crawl(['challenge', 'page', 'page']);
  await run.run();
  // Restarted: the halt holds without a request.
  const blocked = await run.run();
  assert.equal(blocked.processed, 0);
  assert.equal(blocked.stopReason, 'challenge');
  assert.equal(blocked.halt.awaitingReview, 1);
  assert.deepEqual(run.fetched, [run.keys[0]]);

  run.store.recordOperatorDisposition(run.keys[0], { kind: 'hold', operatorId: 'ops', reason: 'looked at the site; continuing without this page' });
  assert.deepEqual(run.store.unreviewedChallenges(), []);
  const resumed = await run.run();
  assert.equal(resumed.stopped, false);
  assert.equal(resumed.stopReason, null);
  assert.equal(resumed.halt, undefined);
  assert.deepEqual(run.fetched, run.keys);
  assert.deepEqual(resumed.counts, { operator_stop: 1, parsed: 2 });
});

test('a hold from before a release does not review a new challenge on the retried page', async () => {
  const run = crawl(['challenge', 'page']);
  await run.run();
  run.store.recordOperatorDisposition(run.keys[0], { kind: 'hold', operatorId: 'ops', reason: 'waiting a day' });
  run.store.recordOperatorDisposition(run.keys[0], { kind: 'release_retry', operatorId: 'ops', reason: 'trying again' });
  const retried = await run.run();
  assert.deepEqual(run.fetched, [run.keys[0], run.keys[0]], 'the released page is tried first, and challenged again');
  assert.equal(retried.stopReason, 'challenge');
  assert.equal(run.store.unreviewedChallenges().length, 1);
  run.store.recordOperatorDisposition(run.keys[0], { kind: 'release_permanent', operatorId: 'ops', reason: 'the page is blocked for good' });
  const finished = await run.run();
  assert.equal(finished.stopReason, null);
  assert.equal(run.store.getJob(run.keys[1]).state, 'parsed');
});

test('a 429 with a usable Retry-After, a server error and a page-level stop do not halt the run', async () => {
  const run = crawl(['rateLimited', 'serverError', 'hardStop', 'page']);
  // runOnce: the two retries wait until 2099, which the long-running loop would sleep for.
  const result = await run.orchestrator.runOnce('worker');
  assert.equal(result.halt, undefined);
  assert.deepEqual(run.fetched, run.keys, 'every page is tried');
  assert.deepEqual(result.counts, { operator_stop: 1, parsed: 1, retry_wait: 2 });
  assert.deepEqual(run.store.unreviewedChallenges(), [], 'a page-level stop stops its page but not the crawl');
  assert.equal(run.events.some(([name]) => name === 'run.halted'), false);
});

// #113: when the site says to stop, or gives no way to tell when to go on, the whole run halts.
for (const [outcome, code] of [['rateLimitCap', 'rate_limit_cap'], ['invalidRetryAfter', 'invalid_retry_after'], ['retryAfterTooLong', 'retry_after_too_long']]) {
  test(`a ${code} stop halts the run until it is reviewed, like a challenge`, async () => {
    const run = crawl([outcome, 'page', 'page']);
    const result = await run.orchestrator.runOnce('worker');
    assert.deepEqual(result.halt, { reason: code, jobKey: run.keys[0], pageType: 'season', awaitingReview: 1 });
    assert.deepEqual(run.fetched, [run.keys[0]], 'nothing after it is tried');
    assert.equal(run.store.unreviewedChallenges()[0].code, code);
    // A restarted worker makes no request until an operator has reviewed the stop.
    const restarted = await run.orchestrator.run({ workerId: 'worker', maxIdleMs: 1, sleep: async () => {} });
    assert.deepEqual([restarted.stopped, restarted.stopReason, restarted.processed], [true, code, 0]);
    assert.deepEqual(run.fetched, [run.keys[0]]);
    run.store.recordOperatorDisposition(run.keys[0], { kind: 'release_retry', operatorId: 'ops', reason: 'reviewed' });
    assert.deepEqual(run.store.unreviewedChallenges(), []);
  });
}

test('a signal stop reports its own reason', async () => {
  const run = crawl(['page', 'page']);
  const controller = new AbortController();
  controller.abort();
  const result = await run.orchestrator.run({ workerId: 'worker', signal: controller.signal });
  assert.deepEqual([result.stopped, result.stopReason, result.processed], [true, 'signal', 0]);
});

test('a fixture run halts on the first challenged page and counts the halt in the crawl log', async () => {
  const lines = [];
  const log = createCrawlLog({ write: (line) => lines.push(JSON.parse(line)) });
  const transport = { calls: [], async request({ url }) { this.calls.push(url); return { status: 403, headers: {}, body: Buffer.alloc(0) }; } };
  const app = createFixtureApplication({ sharedState: { transport }, events: log });
  const first = await app.runWorkerOnce();
  assert.equal(transport.calls.length, 1);
  assert.equal(first.halt.reason, 'challenge');
  assert.equal(log.counters().runHalts, 1);
  assert.ok(lines.some((line) => line.event === 'run.halted' && line.jobKey === first.halt.jobKey));
  const again = await app.runWorkerOnce();
  assert.equal(transport.calls.length, 1, 'no request while the challenge awaits review');
  assert.equal(again.processed, 0);
});

test('worker mode exits 6 when the crawl halts on a challenge', async () => {
  const errors = [];
  const output = [];
  const halt = { reason: 'challenge', jobKey: 'sports-reference:www.sports-reference.com/cbb/schools:school_index', pageType: 'school_index', awaitingReview: 1 };
  const { readFileSync } = await import('node:fs');
  const record = (name) => JSON.parse(readFileSync(new URL(`../config/personal-use.${name}.json`, import.meta.url), 'utf8'));
  const authorization = record('authorization');
  const result = await runCli({
    mode: 'worker', stdout: (line) => output.push(line), stderr: (line) => errors.push(line), crawlLog: { emit() {}, summary() {} },
    env: { PROVIDER_ID: authorization.providerId, PROVIDER_HOST: authorization.scope.allowedHosts[0], USER_AGENT: 'test (+ops@example.com)',
      RAW_STORE_ROOT: process.cwd(), AUTHORIZATION_JSON: JSON.stringify(authorization), DATA_CONTRACT_JSON: JSON.stringify(record('data-contract')),
      PERSISTENCE: 'postgres', PGHOST: 'db', PGDATABASE: 'scraper', PGUSER: 'scraper' },
    startWorker: async () => ({ workerId: 'w', close: async () => {}, orchestrator: { run: async () => ({ processed: 1, stopped: true, stopReason: 'challenge', halt, outcomes: {}, counts: {} }) } }),
  });
  assert.equal(result.exitCode, EXIT_CODES.haltedForReview);
  assert.equal(EXIT_CODES.haltedForReview, 6);
  assert.match(errors.at(-1), /worker halted: a challenge response on .*school_index awaits operator review/);
  assert.equal(JSON.parse(output.at(-1)).stopReason, 'challenge');
});

test('the operator trigger refuses to start while a challenge awaits review', async (t) => {
  const { once } = await import('node:events');
  let started = 0;
  const operator = createOperatorServer({ pin: 'correct horse battery', liveClaims: async () => 0, status: async () => ({}),
    unreviewedChallenges: async () => [{ jobKey: 'k', url: 'https://www.sports-reference.com/cbb/schools/', code: 'challenge' }],
    startRun: async () => { started += 1; return {}; } });
  operator.server.listen(0, '127.0.0.1');
  await once(operator.server, 'listening');
  t.after(() => new Promise((resolve) => operator.server.close(resolve)));
  const base = `http://127.0.0.1:${operator.server.address().port}`;
  const post = (action) => fetch(`${base}/operator/${action}`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ pin: 'correct horse battery' }) });
  const refused = await post('trigger');
  assert.equal(refused.status, 409);
  assert.match((await refused.json()).message, /The crawl is halted: 1 challenge stop .*await review/);
  assert.equal(started, 0);
  const status = await (await post('status')).json();
  assert.match(status.message, /The crawl is halted/);
  assert.equal(status.detail.challengesAwaitingReview.length, 1);
});
