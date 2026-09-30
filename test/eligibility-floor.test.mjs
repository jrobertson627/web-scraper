import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfiguration } from '../src/config/configuration.mjs';
import { createSnapshot, createJob } from '../src/contracts/boundaries.mjs';
import { EXPECTED_ELIGIBLE_SCHOOLS, MIN_ELIGIBLE_SCHOOLS, canonicalizeSourceUrl, createSourceUrl, sourceKey } from '../src/contracts/source.mjs';
import { targetEndingYearsFor } from '../src/contracts/season.mjs';
const TARGET_ENDING_YEARS = targetEndingYearsFor(2026);
import { Discovery } from '../src/discovery/index.mjs';
import { Fetcher, FixtureTransport } from '../src/fetcher/index.mjs';
import { Normalizer } from '../src/domain/public.mjs';
import { FixtureParser, ParserRegistry } from '../src/parsers/index.mjs';
import { InMemoryPersistence, MemoryRawStore } from '../src/persistence/index.mjs';
import { IngestionOrchestrator } from '../src/application/orchestrator.mjs';
import { buildReconciliationReport } from '../src/application/reconciliation.mjs';
import { schoolIndexDocument } from '../src/application/fixture-documents.mjs';

// #115: a school index that yields far fewer eligible schools than expected
// (for example because the site added a new season, so every active school's To
// is 2027) must fail loudly, not pass as a successful crawl with no children.

const HOST = 'allowed.example';
const indexUrl = createSourceUrl('p', `https://${HOST}/cbb/schools/`);
const indexOf = (count, to = 2026) => schoolIndexDocument(Array.from({ length: count }, (_, index) => (
  { path: `/school/${index}`, name: `School ${index}`, to, historyUrl: `https://${HOST}/school/${index}/men/` })));

function discover(document, minEligibleSchools) {
  const discovery = new Discovery({ providerId: 'p', allowedHosts: [HOST], targetEndingYears: TARGET_ENDING_YEARS, minEligibleSchools });
  const snapshot = createSnapshot({
    jobKey: 'index', sourceUrl: indexUrl, body: Buffer.from('{}'),
    sourceUrlFrom: (target, baseUrl = indexUrl.absoluteUrl) => createSourceUrl('p', target, baseUrl),
  });
  return discovery.discover('school_index', snapshot, document);
}

test('the floor sits below a normal season and well above a rolled-over index', () => {
  assert.equal(EXPECTED_ELIGIBLE_SCHOOLS, 360);
  assert.ok(MIN_ELIGIBLE_SCHOOLS < EXPECTED_ELIGIBLE_SCHOOLS && MIN_ELIGIBLE_SCHOOLS > 200);
});

test('an index at or above the floor queues a history page per eligible school', () => {
  assert.equal(discover(indexOf(3), 3).childJobs.length, 3);
  assert.equal(discover(indexOf(5), 3).childJobs.length, 5);
});

test('an index below the floor fails and says why', () => {
  assert.throws(() => discover(indexOf(2), 3), /only 2 eligible schools; expected at least 3 \(about 360\)/);
  assert.throws(() => discover(indexOf(1), 3), /only 1 eligible school;/);
});

test('an index whose active schools all moved to a new season fails instead of queueing nothing', () => {
  // Every school's To is 2027, so To == 2026 matches none of them.
  assert.throws(() => discover(indexOf(400, 2027), MIN_ELIGIBLE_SCHOOLS), (error) => /only 0 eligible schools/.test(error.message) && /To == 2026/.test(error.message) && /new season/.test(error.message));
  // Without a floor the same index silently queues nothing: the failure mode this check removes.
  assert.equal(discover(indexOf(400, 2027), 0).childJobs.length, 0);
});

test('the floor is a configuration value that defaults to off and is validated', () => {
  const base = {
    mode: 'local', providerId: 'p', allowedHosts: [HOST], rawStore: 'memory', publication: 'private',
    policy: { minIntervalMs: 6000, maxRequestsPerMinute: 10, hostConcurrency: 1, userAgent: 'scraper (+ops@example.com)' },
    eligibilityPredicate: 'To == CurrentSeasonEndingYear', currentSeasonEndingYear: 2026, targetEndingYears: [2022, 2023, 2024, 2025, 2026],
  };
  assert.equal(validateConfiguration(base).minEligibleSchools, 0);
  assert.equal(validateConfiguration({ ...base, minEligibleSchools: 300 }).minEligibleSchools, 300);
  for (const bad of [-1, 1.5, '300', 20_000]) assert.throws(() => validateConfiguration({ ...base, minEligibleSchools: bad }), /minEligibleSchools is invalid/, String(bad));
});

// A minimal worker: an index page served by a fixture transport, parsed and discovered.
async function runIndex(document, minEligibleSchools, seasonEndingYear = 2026) {
  let time = Date.parse('2026-01-01T00:00:00.000Z');
  const clock = () => new Date(time);
  const persistence = new InMemoryPersistence(clock);
  const rawStore = new MemoryRawStore();
  const canonicalPath = canonicalizeSourceUrl(indexUrl);
  persistence.addJob(createJob({ key: sourceKey(canonicalPath, 'school_index'), pageType: 'school_index', sourceUrl: indexUrl, canonicalPath }));
  const transport = new FixtureTransport(new Map([[indexUrl.absoluteUrl, { body: JSON.stringify(document) }]]));
  const parsers = new ParserRegistry();
  parsers.register(new FixtureParser('school_index'));
  const orchestrator = new IngestionOrchestrator({
    fetcher: new Fetcher({
      transport, rawStore, persistence, clock, sleep: async (ms) => { time += ms; }, allowedHosts: [HOST],
      policy: { minIntervalMs: 6000, maxRequestsPerMinute: 10, hostConcurrency: 1, userAgent: 'scraper (+ops@example.com)' },
    }),
    discovery: new Discovery({ providerId: 'p', allowedHosts: [HOST], targetEndingYears: TARGET_ENDING_YEARS, seasonEndingYear, minEligibleSchools }),
    parsers, normalizer: new Normalizer(), persistence, rawStore, clock,
  });
  return { result: await orchestrator.runOnce(), persistence };
}

test('a rolled-over index ends the index job as parse_failed with the reason, and queues nothing', async () => {
  const { result, persistence } = await runIndex(indexOf(400, 2027), MIN_ELIGIBLE_SCHOOLS);
  assert.equal(result.events[0].kind, 'parse_failed');
  assert.match(result.events[0].reason, /only 0 eligible schools/);
  const jobs = persistence.listJobs();
  assert.equal(jobs.length, 1, 'no history page was queued');
  assert.equal(jobs[0].state, 'parse_failed');
});

test('the same index above the floor is discovered normally', async () => {
  const { result, persistence } = await runIndex(indexOf(400), MIN_ELIGIBLE_SCHOOLS);
  assert.equal(result.events[0].kind, 'parsed');
  assert.equal(persistence.listJobs().length, 401, 'the index plus a history page per eligible school');
});

test('reconciliation fails an index below the floor even when its stored decisions agree with the rule', async () => {
  const { persistence } = await runIndex(indexOf(400, 2027), 0);
  const withoutFloor = await buildReconciliationReport(persistence);
  assert.equal(withoutFloor.checks.find((check) => check.id === 'eligible_school_count').passed, true, 'each stored decision agrees with To == 2026, so nothing else notices');
  const withFloor = await buildReconciliationReport(persistence, { minEligibleSchools: MIN_ELIGIBLE_SCHOOLS });
  const check = withFloor.checks.find((entry) => entry.id === 'eligible_school_count');
  assert.equal(check.passed, false);
  assert.deepEqual(check.records, [{ key: check.records[0].key, eligibleSchools: 0, minimum: MIN_ELIGIBLE_SCHOOLS }]);
  assert.equal(withFloor.passed, false);

  const healthy = (await runIndex(indexOf(400), 0)).persistence;
  assert.equal((await buildReconciliationReport(healthy, { minEligibleSchools: MIN_ELIGIBLE_SCHOOLS })).checks.find((entry) => entry.id === 'eligible_school_count').passed, true);
});

test('an index read under the season it lists passes the floor, and reconciliation checks each decision against that season', async () => {
  const { result, persistence } = await runIndex(indexOf(400, 2027), MIN_ELIGIBLE_SCHOOLS, 2027);
  assert.equal(result.events[0].kind, 'parsed');
  assert.equal(persistence.listJobs().length, 401);
  const report = await buildReconciliationReport(persistence, { minEligibleSchools: MIN_ELIGIBLE_SCHOOLS });
  assert.equal(report.checks.find((check) => check.id === 'eligible_school_count').passed, true, 'each decision was made under 2027 and matches To == 2027');
});
