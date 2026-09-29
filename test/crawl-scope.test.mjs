import test from 'node:test';
import assert from 'node:assert/strict';
import { createFixtureApplication } from '../src/application/composition-root.mjs';
import { buildReconciliationReport } from '../src/application/reconciliation.mjs';
import { formatCrawlStatus, summarizeCrawlStatus } from '../src/application/crawl-status.mjs';
import { EXIT_CODES, runCli } from '../src/application/cli.mjs';
import { SPORTS_REFERENCE_HOST, SportsReferenceSourceAdapter } from '../src/application/sports-reference-source-adapter.mjs';
import { FULL_CRAWL_SCOPE, createCrawlScope, nextCrawlScope, scopeCovers } from '../src/contracts/crawl-scope.mjs';
import { TARGET_ENDING_YEARS } from '../src/contracts/source.mjs';
import { validateConfiguration } from '../src/config/configuration.mjs';
import { Discovery } from '../src/discovery/index.mjs';
import { InMemoryPersistence, MemoryRawStore } from '../src/persistence/index.mjs';
import { foundationCorpus } from '../fixtures/foundation-corpus.mjs';
import { captureLinkDocument, captureSkip, captureSnapshot } from '../fixtures/sports-reference/captures.mjs';

const SAMPLE = { schools: ['/school/a'], endingYears: [2026] };
const job = (path, pageType) => `fixture-provider:fixture.example${path}:${pageType}`;
const policy = { minIntervalMs: 6000, maxRequestsPerMinute: 10, hostConcurrency: 1, userAgent: 'scraper (+ops@example.com)' };

// Fixture crawls that share one store, as successive worker runs would.
function sharedStore() {
  let time = Date.parse('2026-01-01T00:00:00.000Z');
  return { persistence: new InMemoryPersistence(() => new Date(time)), rawStore: new MemoryRawStore(), clock: () => new Date(time), sleep: async (ms) => { time += ms; } };
}

async function crawl(state, crawlScope) {
  const app = createFixtureApplication({ fixtureEntries: foundationCorpus(), sharedState: state, crawlScope });
  await app.runWorkerOnce();
  return app;
}

test('a sample is a subset of the full scope and can only widen', () => {
  assert.equal(createCrawlScope(undefined), FULL_CRAWL_SCOPE);
  assert.deepEqual(FULL_CRAWL_SCOPE.endingYears, [...TARGET_ENDING_YEARS]);
  const sample = createCrawlScope({ schools: ['/cbb/schools/le-moyne/men/', '/cbb/schools/duke/men/'], endingYears: [2024] });
  assert.deepEqual(sample, { kind: 'sample', schools: ['/cbb/schools/duke/men/', '/cbb/schools/le-moyne/men/'], endingYears: [2024] });
  for (const [input, message] of [
    [{ schools: ['/a/'], endingYears: [2021] }, /endingYears must be distinct years from 2022/],
    [{ schools: ['/a/'], endingYears: [2024, 2024] }, /endingYears/],
    [{ schools: [], endingYears: [2024] }, /schools must list/],
    [{ schools: ['https://www.sports-reference.com/cbb/schools/duke/men/'], endingYears: [2024] }, /site paths/],
    [{ schools: ['/cbb/../x/'], endingYears: [2024] }, /site paths/],
    [{ schools: ['/a/', '/a/'], endingYears: [2024] }, /repeat/],
    [{ schools: ['/a/'], endingYears: [2024], eligibility: 'To >= 2025' }, /unknown fields eligibility/],
    [{ kind: 'everything', schools: ['/a/'], endingYears: [2024] }, /kind everything is invalid/],
  ]) assert.throws(() => createCrawlScope(input), message);

  const wider = createCrawlScope({ schools: ['/cbb/schools/duke/men/', '/cbb/schools/le-moyne/men/', '/cbb/schools/unc/men/'], endingYears: [2024, 2025] });
  assert.equal(scopeCovers(wider, sample), true);
  assert.equal(scopeCovers(sample, wider), false);
  assert.equal(scopeCovers(FULL_CRAWL_SCOPE, wider), true);
  assert.equal(scopeCovers(wider, FULL_CRAWL_SCOPE), false);
  assert.deepEqual(nextCrawlScope(null, sample), { scope: sample, changed: true, widened: false });
  assert.deepEqual(nextCrawlScope(sample, sample), { scope: sample, changed: false, widened: false });
  assert.equal(nextCrawlScope(sample, undefined).widened, true);
  assert.throws(() => nextCrawlScope(FULL_CRAWL_SCOPE, sample), /crawl scope refused: this store was crawled under the full scope/);
});

test('a sample never loosens the full-scope checks', () => {
  const base = { mode: 'local', providerId: 'p', allowedHosts: ['allowed.example'], rawStore: 'memory', publication: 'private', policy,
    eligibilityPredicate: 'To == 2026', targetEndingYears: [2022, 2023, 2024, 2025, 2026] };
  assert.deepEqual(validateConfiguration({ ...base, crawlScope: SAMPLE }).crawlScope, { kind: 'sample', ...SAMPLE });
  assert.equal(validateConfiguration(base).crawlScope, FULL_CRAWL_SCOPE);
  assert.throws(() => validateConfiguration({ ...base, crawlScope: { schools: ['/a/'], endingYears: [2020] } }), /crawlScope is invalid/);
  // The sample is a separate restriction; the scope it restricts must still be exact.
  assert.throws(() => validateConfiguration({ ...base, targetEndingYears: [2024], crawlScope: SAMPLE }), /targetEndingYears is invalid/);
  assert.throws(() => validateConfiguration({ ...base, eligibilityPredicate: 'To >= 2024', crawlScope: SAMPLE }), /eligibilityPredicate is invalid/);
});

test('a sample crawl queues only its schools and years, still records every eligibility decision, and is labeled', async () => {
  const state = sharedStore();
  const app = await crawl(state, SAMPLE);
  const keys = app.persistence.listJobs().map((entry) => entry.key);
  assert.ok(keys.includes(job('/school/a/men', 'school_history')));
  assert.ok(!keys.includes(job('/school/b/men', 'school_history')), 'school b is eligible but not in the sample');
  assert.ok(keys.includes(job('/school/a/men/2026.html', 'season')));
  assert.ok(!keys.includes(job('/school/a/men/2024.html', 'season')), '2024 is not a sample year');
  assert.ok(app.persistence.listJobs().every((entry) => entry.state === 'parsed'));
  const eligibility = app.persistence.acceptedObservations([job('/cbb/schools', 'school_index')]).map(({ observation }) => [observation.school.name, observation.eligible]);
  assert.deepEqual(eligibility, [['Fixture A', true], ['Fixture B', true], ['Fixture C', false]]);
  assert.deepEqual(app.persistence.coverageGaps(), [], 'no gap is recorded for years outside the sample');

  const report = await buildReconciliationReport(app.persistence);
  assert.deepEqual(report.scope, { kind: 'sample', ...SAMPLE });
  for (const id of ['eligible_school_count', 'linked_season_count', 'partial_coverage', 'linked_game_resolution']) {
    assert.equal(report.checks.find((check) => check.id === id).passed, true, id);
  }
  const status = summarizeCrawlStatus(await app.persistence.crawlStatus());
  assert.match(formatCrawlStatus(status), /scope: SAMPLE, not complete coverage: 1 school\(s\) \(\/school\/a\), ending years 2026/);
});

test('widening a sample to the full scope rediscovers stored pages without refetching them', async () => {
  const state = sharedStore();
  const sample = await crawl(state, SAMPLE);
  const sampled = new Set(sample.transport.calls);
  const full = await crawl(state, undefined);
  assert.deepEqual(state.persistence.crawlScopes.map((entry) => entry.scope.kind), ['sample', 'full']);
  const refetched = full.transport.calls.filter((url) => sampled.has(url));
  assert.deepEqual(refetched, [], 'the index and school a history were read from storage, not refetched');
  const keys = state.persistence.listJobs().map((entry) => entry.key);
  assert.ok(keys.includes(job('/school/b/men', 'school_history')));
  assert.ok(keys.includes(job('/school/a/men/2024.html', 'season')));
  assert.ok(state.persistence.listJobs().every((entry) => entry.state === 'parsed'));
  // The result reconciles exactly like a crawl that was full from the start.
  const fresh = await crawl({ ...sharedStore() }, undefined);
  assert.deepEqual(await full.reconcile(), await fresh.reconcile());
  assert.equal((await full.reconcile()).passed, true);
});

test('a store crawled under the full scope refuses a sample, and a wider sample is accepted', async () => {
  const state = sharedStore();
  await crawl(state, undefined);
  await assert.rejects(crawl(state, SAMPLE), /crawl scope refused: this store was crawled under the full scope/);
  const sampled = sharedStore();
  await crawl(sampled, SAMPLE);
  const wider = await crawl(sampled, { schools: ['/school/a', '/school/b'], endingYears: [2026] });
  assert.ok(wider.persistence.listJobs().some((entry) => entry.key === job('/school/b/men', 'school_history')));
  await assert.rejects(crawl(sampled, SAMPLE), /does not cover/);
});

test('worker mode reads CRAWL_SAMPLE and rejects an invalid one before starting', async () => {
  const errors = [];
  let started;
  const env = { USER_AGENT: 'test (+ops@example.com)', RAW_STORE_ROOT: process.cwd(), PERSISTENCE: 'postgres', PGHOST: 'db', PGDATABASE: 'scraper', PGUSER: 'scraper' };
  const run = (overrides) => runCli({ mode: 'worker', env: { ...env, ...overrides }, stdout: () => {}, stderr: (line) => errors.push(line),
    startWorker: async ({ config }) => { started = config; throw new Error('stop here'); } });
  assert.equal((await run({ CRAWL_SAMPLE: '{"schools":' })).exitCode, EXIT_CODES.configurationRejected);
  assert.match(errors.at(-1), /CRAWL_SAMPLE is invalid JSON/);
  assert.equal(started, undefined);
});

test('the real school index queues only the sample\'s school histories', { skip: captureSkip('/cbb/schools/') }, () => {
  const discovery = new Discovery({ providerId: 'sports-reference', allowedHosts: [SPORTS_REFERENCE_HOST], targetEndingYears: TARGET_ENDING_YEARS,
    sourceAdapter: new SportsReferenceSourceAdapter(),
    scope: createCrawlScope({ schools: ['/cbb/schools/duke/men/', '/cbb/schools/le-moyne/men/'], endingYears: [2024] }) });
  const result = discovery.discover('school_index', captureSnapshot('/cbb/schools/', { jobKey: 'sports-reference:www.sports-reference.com/cbb/schools:school_index' }),
    captureLinkDocument('school_index', '/cbb/schools/'));
  assert.deepEqual(result.childJobs.map((child) => child.schoolSourcePath).sort(),
    ['sports-reference:www.sports-reference.com/cbb/schools/duke/men', 'sports-reference:www.sports-reference.com/cbb/schools/le-moyne/men']);
  assert.ok(result.observations.filter((entry) => entry.kind === 'school' && entry.eligible).length > 300, 'every row is still observed');
});
