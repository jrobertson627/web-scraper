import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateConfiguration } from '../src/config/configuration.mjs';
import { createSnapshot } from '../src/contracts/boundaries.mjs';
import { FULL_CRAWL_SCOPE, createCrawlScope, fullCrawlScope, nextCrawlScope, scopeCovers } from '../src/contracts/crawl-scope.mjs';
import {
  ELIGIBILITY_RULE, LEGACY_SEASON_ENDING_YEAR, SEASON_ROLLOVER_MONTH, TARGET_YEARS_RULE, resolveSeasonEndingYear, seasonEndingYearAt, targetEndingYearsFor,
} from '../src/contracts/season.mjs';
import { createSourceUrl, isEligibleSchool } from '../src/contracts/source.mjs';
import { Discovery } from '../src/discovery/index.mjs';
import { schoolHistoryDocument, schoolIndexDocument } from '../src/application/fixture-documents.mjs';
import { SchoolHistoryParser } from '../src/parsers/school-history.mjs';

// #115: eligibility is To == the current season's ending year, and the target
// seasons are the last five up to it. The season comes from the calendar, is
// decided when the school index is fetched, and can be pinned.

const at = (iso) => new Date(iso);

test('the season rolls over on the first of the rollover month, in UTC', () => {
  assert.equal(SEASON_ROLLOVER_MONTH, 11);
  assert.equal(seasonEndingYearAt(at('2026-09-29T00:00:00Z')), 2026, 'the 2025-26 season is the latest before the next one starts');
  assert.equal(seasonEndingYearAt(at('2026-10-31T23:59:59Z')), 2026);
  assert.equal(seasonEndingYearAt(at('2026-11-01T00:00:00Z')), 2027);
  assert.equal(seasonEndingYearAt(at('2027-01-15T00:00:00Z')), 2027);
  assert.equal(seasonEndingYearAt(at('2027-06-30T00:00:00Z')), 2027);
  assert.equal(seasonEndingYearAt(at('2027-11-01T00:00:00Z')), 2028);
  assert.equal(seasonEndingYearAt(at('2026-12-31T23:59:59Z')), 2027);
  assert.throws(() => seasonEndingYearAt('2026-01-01'), /valid date/);
});

test('the target window is the five ending years up to the season', () => {
  assert.deepEqual([...targetEndingYearsFor(2026)], [2022, 2023, 2024, 2025, 2026]);
  assert.deepEqual([...targetEndingYearsFor(2027)], [2023, 2024, 2025, 2026, 2027]);
  assert.throws(() => targetEndingYearsFor(26), /four-digit year/);
  assert.throws(() => targetEndingYearsFor('2026'), /four-digit year/);
  assert.equal(LEGACY_SEASON_ENDING_YEAR, 2026);
});

test('the season is decided by the index fetch time, so a restart after the rollover keeps it', () => {
  // The index was fetched on 2026-10-20 and the worker restarts on 2026-11-02.
  assert.deepEqual(resolveSeasonEndingYear({ indexFetchedAt: '2026-10-20T12:00:00Z', now: at('2026-11-02T00:00:00Z') }), { seasonEndingYear: 2026, source: 'index_fetch' });
  // Before the index has been fetched it is the season now.
  assert.deepEqual(resolveSeasonEndingYear({ now: at('2026-11-02T00:00:00Z') }), { seasonEndingYear: 2027, source: 'clock' });
  // An explicit year wins over both: the operator saying which season the index lists.
  assert.deepEqual(resolveSeasonEndingYear({ explicit: 2027, indexFetchedAt: '2026-10-20T12:00:00Z', now: at('2026-10-21T00:00:00Z') }), { seasonEndingYear: 2027, source: 'configured' });
  assert.throws(() => resolveSeasonEndingYear({ explicit: 27, now: at('2026-01-01T00:00:00Z') }), /four-digit year/);
});

const HOST = 'allowed.example';
const indexUrl = createSourceUrl('p', `https://${HOST}/cbb/schools/`);
const schools = (count, to) => Array.from({ length: count }, (_, index) => ({ path: `/school/${index}`, name: `School ${index}`, to, historyUrl: `https://${HOST}/school/${index}/men/` }));
const snapshotOf = (url) => createSnapshot({
  jobKey: `job:${url.path}`, sourceUrl: url, body: Buffer.from('{}'), schoolSourcePath: 'p:allowed.example/school/0/men',
  sourceUrlFrom: (target, baseUrl = url.absoluteUrl) => createSourceUrl('p', target, baseUrl),
});

test('eligibility follows the season: To equal to its ending year, whichever year that is', () => {
  assert.equal(isEligibleSchool({ to: 2026 }, 2026), true);
  assert.equal(isEligibleSchool({ to: 2027 }, 2026), false);
  assert.equal(isEligibleSchool({ to: 2027 }, 2027), true);
  assert.equal(isEligibleSchool(undefined, 2026), false);
});

test('an index whose active schools moved to the next season is read under that season', () => {
  const discovery = new Discovery({ providerId: 'p', allowedHosts: [HOST], seasonEndingYear: 2026, minEligibleSchools: 3 });
  const document = schoolIndexDocument([...schools(4, 2027), { path: '/school/gone', name: 'Gone', to: 2019, historyUrl: `https://${HOST}/school/gone/men/` }]);
  assert.throws(() => discovery.discover('school_index', snapshotOf(indexUrl), document), /only 0 eligible schools.*To == 2026.*CURRENT_SEASON_ENDING_YEAR/);
  discovery.useSeason(2027);
  const result = discovery.discover('school_index', snapshotOf(indexUrl), document);
  assert.equal(result.childJobs.length, 4);
  const observed = result.observations.filter((entry) => entry.kind === 'school');
  assert.deepEqual(observed.map((entry) => [entry.eligible, entry.seasonEndingYear]), [[true, 2027], [true, 2027], [true, 2027], [true, 2027], [false, 2027]],
    'each decision records the season it was made under');
});

test('a history page queues the seasons of the window, which moves with the season', () => {
  const historyUrl = createSourceUrl('p', `https://${HOST}/school/0/men/`);
  const rows = [2021, 2022, 2023, 2024, 2025, 2026, 2027].map((endingYear) => ({ endingYear, url: `https://${HOST}/school/0/men/${endingYear}.html` }));
  const discovery = new Discovery({ providerId: 'p', allowedHosts: [HOST], seasonEndingYear: 2026 });
  const years = () => discovery.discover('school_history', snapshotOf(historyUrl), schoolHistoryDocument(rows)).childJobs
    .map((job) => Number(/(\d{4})\.html$/.exec(job.sourceUrl.absoluteUrl)[1]));
  assert.deepEqual(years(), [2022, 2023, 2024, 2025, 2026]);
  discovery.useSeason(2027);
  assert.deepEqual(years(), [2023, 2024, 2025, 2026, 2027]);
});

test('the history parser keeps every linked season from 2022, so a later window has its seasons', () => {
  const html = (endingYear) => `<tr><th data-stat="season"><a href="/cbb/schools/duke/men/${endingYear}.html">${endingYear - 1}-${String(endingYear).slice(2)}</a></th></tr>`;
  const page = `<html><body><table id="duke"><thead><tr><th data-stat="season">Season</th></tr></thead><tbody>${[2027, 2026, 2022, 2021].map(html).join('')}</tbody></table></body></html>`;
  const sourceUrl = createSourceUrl('sports-reference', 'https://www.sports-reference.com/cbb/schools/duke/men/');
  const parsed = new SchoolHistoryParser().parse(createSnapshot({
    jobKey: 'duke', sourceUrl, body: Buffer.from(page),
    sourceUrlFrom: (target, baseUrl = sourceUrl.absoluteUrl) => createSourceUrl('sports-reference', target, baseUrl),
  }));
  assert.equal(parsed.kind, 'valid');
  assert.deepEqual(parsed.document.seasons.map((season) => season.endingYear), [2027, 2026, 2022]);
});

const base = {
  mode: 'local', providerId: 'p', allowedHosts: [HOST], rawStore: 'memory', publication: 'private',
  policy: { minIntervalMs: 6000, maxRequestsPerMinute: 10, hostConcurrency: 1, userAgent: 'scraper (+ops@example.com)' },
  eligibilityPredicate: ELIGIBILITY_RULE,
};

test('configuration derives the season from the clock unless it is pinned, and derives the window from it', () => {
  const clock = (iso) => ({ clock: () => at(iso) });
  const october = validateConfiguration(base, clock('2026-10-15T00:00:00Z'));
  assert.deepEqual([october.currentSeasonEndingYear, october.seasonYearPinned, [...october.targetEndingYears]], [2026, false, [2022, 2023, 2024, 2025, 2026]]);
  const december = validateConfiguration(base, clock('2026-12-15T00:00:00Z'));
  assert.deepEqual([december.currentSeasonEndingYear, december.seasonYearPinned, [...december.targetEndingYears]], [2027, false, [2023, 2024, 2025, 2026, 2027]]);
  const pinned = validateConfiguration({ ...base, currentSeasonEndingYear: 2026 }, clock('2026-12-15T00:00:00Z'));
  assert.deepEqual([pinned.currentSeasonEndingYear, pinned.seasonYearPinned], [2026, true]);
  assert.throws(() => validateConfiguration({ ...base, currentSeasonEndingYear: 26 }), /currentSeasonEndingYear is invalid/);
  assert.throws(() => validateConfiguration({ ...base, currentSeasonEndingYear: 2027, targetEndingYears: [2022, 2023, 2024, 2025, 2026] }), /targetEndingYears is invalid/);
  assert.throws(() => validateConfiguration({ ...base, eligibilityPredicate: 'To == 2026' }), /eligibilityPredicate is invalid/);
});

test('the authorization record states the rules symbolically, so it stays valid as the season rolls', () => {
  const record = JSON.parse(readFileSync(new URL('../config/personal-use.authorization.json', import.meta.url), 'utf8'));
  assert.equal(record.scope.eligibilityPredicate, ELIGIBILITY_RULE);
  assert.equal(record.scope.targetEndingYears, TARGET_YEARS_RULE);
  assert.doesNotMatch(JSON.stringify(record.scope), /2026|2027/);
});

test('the full scope follows the window, and a rolled window only widens the store', () => {
  assert.equal(createCrawlScope(undefined), FULL_CRAWL_SCOPE, 'the default is the legacy 2022-2026 scope');
  assert.equal(createCrawlScope(undefined, { targetEndingYears: targetEndingYearsFor(2026) }), FULL_CRAWL_SCOPE);
  const rolled = createCrawlScope({ kind: 'full' }, { targetEndingYears: targetEndingYearsFor(2027) });
  assert.deepEqual([...rolled.endingYears], [2023, 2024, 2025, 2026, 2027]);
  assert.deepEqual(fullCrawlScope([2023, 2024, 2025, 2026, 2027]), rolled);
  assert.equal(scopeCovers(rolled, FULL_CRAWL_SCOPE), true, 'a full scope covers any other');
  const next = nextCrawlScope(FULL_CRAWL_SCOPE, rolled);
  assert.deepEqual([next.changed, next.widened], [true, true]);
  assert.deepEqual([...next.scope.endingYears], [2022, 2023, 2024, 2025, 2026, 2027], 'the years already crawled stay in the recorded scope (#154)');
  // A recorded scope is read back as recorded, not as the legacy one.
  assert.deepEqual([...createCrawlScope({ kind: 'full', endingYears: [2023, 2024, 2025, 2026, 2027] }).endingYears], [2023, 2024, 2025, 2026, 2027]);
  // A sample must lie within the window of its season.
  assert.throws(() => createCrawlScope({ schools: ['/a/'], endingYears: [2022] }, { targetEndingYears: targetEndingYearsFor(2027) }), /endingYears must be distinct years from 2023/);
});
