import test from 'node:test';
import assert from 'node:assert/strict';
import { createJob } from '../src/contracts/boundaries.mjs';
import { canonicalizeSourceUrl, createSourceUrl } from '../src/contracts/source.mjs';
import { Discovery } from '../src/discovery/index.mjs';
import { Fetcher, FixtureTransport } from '../src/fetcher/index.mjs';
import { InMemoryPersistence, MemoryRawStore } from '../src/persistence/index.mjs';
import { IngestionOrchestrator } from '../src/application/orchestrator.mjs';
import { snapshotFor } from '../src/application/page-pipeline.mjs';
import { schoolHistoryDocument } from '../src/application/fixture-documents.mjs';

// #124: the final URL of a fetch that followed redirects is recorded, the page's
// links are resolved against it, and a redirect to a different page stops for
// review instead of being parsed under the old identity.

const HOST = 'allowed.example';
const url = (path) => `https://${HOST}${path}`;
const jobFor = (path, pageType = 'season') => {
  const sourceUrl = createSourceUrl('provider', url(path));
  return createJob({ key: `provider:${HOST}${path}:${pageType}`, pageType, sourceUrl, canonicalPath: canonicalizeSourceUrl(sourceUrl) });
};

function harness(fixtures, { jobs, policy = {} } = {}) {
  let now = Date.parse('2026-01-01T00:00:00.000Z');
  const clock = () => new Date(now);
  const persistence = new InMemoryPersistence(clock, { claimTimeoutMs: 30_000, authorizeOperator: () => true });
  const rawStore = new MemoryRawStore();
  const transport = new FixtureTransport(new Map(Object.entries(fixtures)));
  const fetcher = new Fetcher({
    transport, rawStore, persistence, clock, sleep: async (ms) => { now += ms; }, allowedHosts: [HOST],
    policy: { minIntervalMs: 6_000, maxRequestsPerMinute: 10, hostConcurrency: 1, userAgent: 'scraper (+ops@example.com)', ...policy },
  });
  for (const job of jobs) persistence.addJob(job);
  return { persistence, fetcher, rawStore, transport, clock, advance: (ms) => { now += ms; } };
}

test('links are resolved against where the body was served from, not the queued URL', () => {
  const job = jobFor('/cbb/schools/duke/men/');
  const plain = snapshotFor(job, Buffer.from('{}'));
  assert.equal(plain.baseUrl, url('/cbb/schools/duke/men/'));
  assert.equal(plain.sourceUrlFrom('2026.html').absoluteUrl, url('/cbb/schools/duke/men/2026.html'));

  const moved = snapshotFor(job, Buffer.from('{}'), { finalUrl: url('/cbb/schools/duke-blue-devils/men/') });
  assert.equal(moved.baseUrl, url('/cbb/schools/duke-blue-devils/men/'));
  assert.equal(moved.sourceUrlFrom('2026.html').absoluteUrl, url('/cbb/schools/duke-blue-devils/men/2026.html'));
  assert.equal(moved.sourceUrl.absoluteUrl, url('/cbb/schools/duke/men/'), 'the page keeps the identity of its job');
  assert.equal(moved.sourceUrlFrom('2026.html', url('/elsewhere/')).absoluteUrl, url('/elsewhere/2026.html'), 'an explicit base still wins');
});

test('discovery follows a page\'s relative links from the final URL', () => {
  const job = jobFor('/cbb/schools/duke/men/', 'school_history');
  const discovery = new Discovery({ providerId: 'provider', allowedHosts: [HOST], seasonEndingYear: 2026 });
  const document = schoolHistoryDocument([{ endingYear: 2026, url: '2026.html' }]);
  const links = (snapshot) => discovery.discover('school_history', snapshot, document).childJobs.map((child) => child.sourceUrl.absoluteUrl);
  assert.deepEqual(links(snapshotFor(job, Buffer.from('{}'))), [url('/cbb/schools/duke/men/2026.html')]);
  assert.deepEqual(links(snapshotFor(job, Buffer.from('{}'), { finalUrl: url('/cbb/schools/duke-blue-devils/men/') })), [url('/cbb/schools/duke-blue-devils/men/2026.html')]);
});

test('a redirect to the same canonical page is fetched, with its final URL recorded and passed on', async () => {
  const job = jobFor('/page?b=1&a=2');
  const run = harness({
    [url('/page?b=1&a=2')]: { redirectUrl: url('/page?a=2&b=1') },
    [url('/page?a=2&b=1')]: { body: '{"ok":true}' },
  }, { jobs: [job] });
  const claimed = run.persistence.claimNextJob(run.clock(), 'worker');
  const result = await run.fetcher.fetch(claimed, claimed.lease);
  assert.deepEqual([result.kind, result.finalUrl], ['fetched', url('/page?a=2&b=1')]);
  assert.equal(run.persistence.lastSuccessfulFetch(job.key).finalUrl, url('/page?a=2&b=1'));
});

test('a page not redirected has no final URL', async () => {
  const job = jobFor('/plain');
  const run = harness({ [url('/plain')]: { body: '{}' } }, { jobs: [job] });
  const claimed = run.persistence.claimNextJob(run.clock(), 'worker');
  const result = await run.fetcher.fetch(claimed, claimed.lease);
  assert.equal(result.finalUrl, undefined);
  assert.equal(run.persistence.lastSuccessfulFetch(job.key).finalUrl, undefined);
});

test('a redirect to a different page stops for review with both URLs, keeps the body, and is not parsed under the old identity', async () => {
  const job = jobFor('/cbb/schools/old-name/men/', 'school_history');
  const run = harness({
    [url('/cbb/schools/old-name/men/')]: { redirectUrl: url('/cbb/schools/new-name/men/') },
    [url('/cbb/schools/new-name/men/')]: { body: '{"seasons":[]}' },
  }, { jobs: [job] });
  let parsed = 0;
  const orchestrator = new IngestionOrchestrator({
    fetcher: run.fetcher, discovery: {}, parsers: { get: () => { parsed += 1; }, parse: () => { parsed += 1; } }, normalizer: {},
    persistence: run.persistence, rawStore: run.rawStore, clock: run.clock,
  });
  const result = await orchestrator.runOnce('worker');
  const [event] = result.events;
  assert.deepEqual([event.kind, event.code], ['operator_stop', 'redirected_identity']);
  assert.ok(event.reason.includes(url('/cbb/schools/old-name/men/')) && event.reason.includes(url('/cbb/schools/new-name/men/')), event.reason);
  assert.equal(parsed, 0, 'the body was never parsed');
  assert.equal(run.persistence.pages.size, 0, 'nothing was stored under the old identity');
  assert.equal(result.halt, undefined, 'a page-level stop does not halt the run');
  const kept = run.persistence.lastSuccessfulFetch(job.key);
  assert.equal(kept.finalUrl, url('/cbb/schools/new-name/men/'));
  assert.equal(run.rawStore.get(kept.checksum).body.toString(), '{"seasons":[]}', 'the body is kept as evidence');
  assert.equal(run.persistence.getJob(job.key).state, 'operator_stop');
  const [summary] = run.persistence.reviewJobs({ states: ['operator_stop'] }).items;
  assert.equal(summary.code, 'redirected_identity');
  assert.deepEqual(run.persistence.unreviewedChallenges(), []);
});

test('a cache hit carries the final URL of the fetch it reuses', async () => {
  const job = jobFor('/cached?b=1&a=2');
  const run = harness({
    [url('/cached?b=1&a=2')]: { redirectUrl: url('/cached?a=2&b=1') },
    [url('/cached?a=2&b=1')]: { body: '{}' },
  }, { jobs: [job], policy: { cacheMaxAgeMs: 3_600_000 } });
  const first = run.persistence.claimNextJob(run.clock(), 'worker');
  assert.equal((await run.fetcher.fetch(first, first.lease)).kind, 'fetched');
  const calls = run.transport.calls.length;
  const again = await run.fetcher.fetch(first, first.lease);
  assert.deepEqual([again.kind, again.finalUrl], ['not_modified', url('/cached?a=2&b=1')]);
  assert.equal(run.transport.calls.length, calls, 'served from the cache, no request');
  assert.equal(run.persistence.lastSuccessfulFetch(job.key).finalUrl, url('/cached?a=2&b=1'));
});
