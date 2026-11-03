import test from 'node:test';
import assert from 'node:assert/strict';
import { createFixtureApplication } from '../src/application/composition-root.mjs';
import { refreshSeason } from '../src/application/season-refresh.mjs';
import { parseReviewArgs } from '../src/application/cli.mjs';
import { createCrawlScope, fullCrawlScope, nextCrawlScope } from '../src/contracts/crawl-scope.mjs';
import { canTransition } from '../src/contracts/jobs.mjs';
import { resolveSeasonEndingYear } from '../src/contracts/season.mjs';
import { InMemoryPersistence, MemoryRawStore } from '../src/persistence/index.mjs';
import { foundationCorpus, rolledFoundationCorpus } from '../fixtures/foundation-corpus.mjs';
import { gameLogDocument, schoolHistoryDocument, seasonDocument } from '../src/application/fixture-documents.mjs';

// #154: when the season rolls over, an operator puts the parsed school index and
// histories back in the queue, and the next worker run reads them under the new
// season, replaces what changed and discovers the new season's pages.

const ORIGIN = 'https://fixture.example';
const OPERATOR = 'ops';

// The store's clock and sleep, so a crawl can run in October and again in November.
function world(startIso) {
  let now = Date.parse(startIso);
  const persistence = new InMemoryPersistence(() => new Date(now));
  persistence.authorizeOperator = (operatorId) => operatorId === OPERATOR;
  return {
    persistence,
    rawStore: new MemoryRawStore(),
    clock: () => new Date(now),
    sleep: async (milliseconds) => { now += milliseconds; },
    setTime: (iso) => { now = Date.parse(iso); },
  };
}

const applicationFor = (shared, entries) => createFixtureApplication({
  fixtureEntries: entries, pinSeason: null,
  sharedState: { persistence: shared.persistence, rawStore: shared.rawStore, clock: shared.clock, sleep: shared.sleep },
});

async function crawledInOctober() {
  const shared = world('2026-10-15T00:00:00Z');
  const first = applicationFor(shared, foundationCorpus());
  await first.runWorkerOnce();
  const root = shared.persistence.listJobs().find((job) => job.pageType === 'school_index');
  return { shared, rootKey: root.key };
}

const refresh = (shared, rootKey, options = {}) => refreshSeason({
  persistence: shared.persistence, rootKey, clock: shared.clock, operatorId: OPERATOR, reason: 'the 2026-27 season started', ...options,
});

test('a parsed job can only go back to the queue through an operator refresh', () => {
  assert.equal(canTransition('parsed', 'retry_wait'), true);
  for (const state of ['pending', 'fetching', 'fetched', 'parsed', 'permanently_failed', 'parse_failed', 'operator_stop']) assert.equal(canTransition('parsed', state), state === 'retry_wait');
});

test('while an index refresh is waiting, the season is the one now, not the stored fetch\'s', () => {
  const now = new Date('2026-11-02T00:00:00Z');
  assert.deepEqual(resolveSeasonEndingYear({ indexFetchedAt: '2026-10-20T00:00:00Z', now }), { seasonEndingYear: 2026, source: 'index_fetch' });
  assert.deepEqual(resolveSeasonEndingYear({ indexFetchedAt: '2026-10-20T00:00:00Z', now, refreshPending: true }), { seasonEndingYear: 2027, source: 'refresh_pending' });
  assert.deepEqual(resolveSeasonEndingYear({ explicit: 2026, indexFetchedAt: '2026-10-20T00:00:00Z', now, refreshPending: true }), { seasonEndingYear: 2026, source: 'configured' }, 'a pinned season still wins');
});

test('a full scope keeps the years already crawled when the window rolls, and a sample is unchanged', () => {
  const old = fullCrawlScope([2022, 2023, 2024, 2025, 2026]);
  const rolled = nextCrawlScope(old, fullCrawlScope([2023, 2024, 2025, 2026, 2027]));
  assert.deepEqual([...rolled.scope.endingYears], [2022, 2023, 2024, 2025, 2026, 2027]);
  assert.equal(rolled.widened, true);
  const again = nextCrawlScope(rolled.scope, fullCrawlScope([2023, 2024, 2025, 2026, 2027]));
  assert.equal(again.changed, false, 'the same window again records nothing');
  const sample = createCrawlScope({ schools: ['/school/a'], endingYears: [2026] });
  assert.deepEqual(nextCrawlScope(sample, sample).changed, false);
});

test('refresh-season names the school index and histories, and needs an operator and a reason', () => {
  assert.deepEqual(parseReviewArgs(['refresh-season', '--operator', 'ops', '--reason', 'new season', '--dry-run']),
    { command: 'refresh-season', dryRun: true, force: false, operatorId: 'ops', reason: 'new season' });
  assert.equal(parseReviewArgs(['refresh-season', '--operator', 'ops', '--reason', 'r', '--force']).force, true);
  assert.throws(() => parseReviewArgs(['refresh-season', '--dry-run']), /needs --operator <id> and --reason/);
  assert.throws(() => parseReviewArgs(['refresh-season', 'some-job', '--operator', 'ops', '--reason', 'r']), /argument some-job is invalid/);
});

test('a refresh before the season moves on, or of a store that never fetched its index, does nothing', async () => {
  const empty = world('2026-10-15T00:00:00Z');
  await assert.rejects(refresh(empty, 'missing:key'), /not queued yet/);
  const { shared, rootKey } = await crawledInOctober();
  const same = await refresh(shared, rootKey);
  assert.deepEqual([same.status, same.storedSeasonEndingYear, same.seasonEndingYear], ['current', 2026, 2026]);
  assert.equal(shared.persistence.getJob(rootKey).state, 'parsed');
  assert.equal(shared.persistence.getJob(rootKey).refreshRequestedAt, undefined);
  shared.setTime('2025-06-01T00:00:00Z');
  await assert.rejects(refresh(shared, rootKey), /A refresh moves forward; use --force/);
  const forced = await refresh(shared, rootKey, { force: true, dryRun: true });
  assert.equal(forced.status, 'dry_run');
});

test('a season rollover refresh reads the index and histories again and discovers the new season', async () => {
  const { shared, rootKey } = await crawledInOctober();
  const { persistence } = shared;
  assert.deepEqual([...(await persistence.crawlScope()).endingYears], [2022, 2023, 2024, 2025, 2026]);
  const parsedBefore = persistence.listJobs().filter((job) => job.state === 'parsed').length;
  shared.setTime('2026-11-02T00:00:00Z');

  // A dry run says what would happen and changes nothing.
  const dry = await refresh(shared, rootKey, { dryRun: true });
  assert.deepEqual([dry.status, dry.storedSeasonEndingYear, dry.seasonEndingYear, dry.requests, dry.addedYears], ['dry_run', 2026, 2027, 3, [2027]]);
  assert.deepEqual(dry.jobs, { school_index: 1, school_history: 2 });
  assert.equal(persistence.listJobs().filter((job) => job.state === 'parsed').length, parsedBefore);
  assert.equal(persistence.operatorDispositions.length, 0);

  // An operator not on the list cannot do it, and a refused request changes nothing.
  await assert.rejects(refresh(shared, rootKey, { operatorId: 'intruder' }), /not authorized/);
  assert.equal(persistence.getJob(rootKey).state, 'parsed');

  const queued = await refresh(shared, rootKey);
  assert.deepEqual([queued.status, queued.requests], ['queued', 3]);
  const waiting = persistence.listJobs().filter((job) => job.refreshRequestedAt);
  assert.deepEqual(waiting.map((job) => [job.pageType, job.state]).sort(), [['school_history', 'retry_wait'], ['school_history', 'retry_wait'], ['school_index', 'retry_wait']]);
  assert.equal(persistence.operatorDispositions.filter((entry) => entry.kind === 'refresh').length, 3, 'one recorded disposition each');
  assert.ok(waiting.every((job) => job.failureAttempts === 0 && job.history.some((event) => event.disposition === 'refresh' && event.operatorId === OPERATOR)));
  assert.equal((await refresh(shared, rootKey)).status, 'already_requested', 'asking again queues nothing more');
  assert.equal(persistence.operatorDispositions.length, 3);

  // The worker runs under the new season and the new pages.
  const app = applicationFor(shared, rolledFoundationCorpus());
  await app.runWorkerOnce();
  const jobs = persistence.listJobs();
  assert.ok(jobs.every((job) => job.state === 'parsed'), `every page is parsed: ${JSON.stringify(jobs.filter((job) => job.state !== 'parsed').map((job) => [job.key, job.state]))}`);
  assert.ok(jobs.every((job) => job.refreshRequestedAt === undefined), 'each request is met once its page is parsed');
  assert.ok(jobs.some((job) => job.pageType === 'season' && job.key.includes('2027')), 'the 2027 season page was discovered');
  assert.deepEqual(persistence.openIssues(), [], 'the changed pages replaced the accepted records instead of being held as conflicts');

  const index = jobs.find((job) => job.pageType === 'school_index');
  const observed = [...persistence.acceptedObservations([index.key])].map((entry) => entry.observation).filter((entry) => entry.kind === 'school');
  assert.deepEqual(observed.map((entry) => [entry.eligible, entry.seasonEndingYear]), [[true, 2027], [true, 2027], [false, 2027]]);
  assert.deepEqual([...(await persistence.crawlScope()).endingYears], [2022, 2023, 2024, 2025, 2026, 2027], 'the years already crawled stay in the scope');
  // The index fetched now carries the new season, so a restart reads it the same way.
  assert.equal(persistence.lastSuccessfulFetch(rootKey).fetchedAt.startsWith('2026-11-02'), true);

  const report = await app.reconcile();
  assert.deepEqual(report.checks.filter((check) => !check.passed).map((check) => [check.id, check.records.slice(0, 2)]), [], 'the store still reconciles');
  assert.equal(persistence.coverageGaps().some((gap) => gap.endingYear === 2027 && gap.schoolSourcePath.endsWith('/school/a')), false, 'A has a 2027 season');
  assert.equal(persistence.coverageGaps().some((gap) => gap.endingYear === 2027 && gap.schoolSourcePath.endsWith('/school/b')), true, 'B has none yet');
});

test('a year recorded as unavailable stops being unavailable once a later refresh finds it linked', async () => {
  const { shared, rootKey } = await crawledInOctober();
  shared.setTime('2026-11-02T00:00:00Z');
  await refresh(shared, rootKey);
  // The site has rolled its index but B's history does not link 2027 yet.
  const early = foundationCorpus().map((entry) => rolledFoundationCorpus().find((rolled) => rolled.url === entry.url) ?? entry);
  const withoutA2027 = early.map((entry) => (entry.url === `${ORIGIN}/school/a/men/` ? foundationCorpus().find((original) => original.url === entry.url) : entry));
  await applicationFor(shared, withoutA2027).runWorkerOnce();
  const gap = (path) => shared.persistence.coverageGaps().some((entry) => entry.endingYear === 2027 && entry.schoolSourcePath.endsWith(path));
  assert.equal(gap('/school/a'), true, 'A has no 2027 link yet');
  shared.setTime('2026-11-09T00:00:00Z');
  await refresh(shared, rootKey, { force: true });
  await applicationFor(shared, rolledFoundationCorpus()).runWorkerOnce();
  assert.equal(gap('/school/a'), false, 'and once it does, the unavailable record is gone');
  assert.deepEqual(shared.persistence.openIssues(), []);
});

test('only parsed school index and history pages can be refreshed, and all or none', async () => {
  const { shared } = await crawledInOctober();
  const { persistence } = shared;
  const jobs = persistence.listJobs();
  const history = jobs.find((job) => job.pageType === 'school_history');
  const season = jobs.find((job) => job.pageType === 'season');
  const request = (keys) => persistence.requestRefresh({ keys, operatorId: OPERATOR, reason: 'r' });
  assert.throws(() => request([history.key, season.key]), /refresh needs a parsed school_index or school_history job/);
  assert.throws(() => request(['missing']), /missing/);
  assert.equal(persistence.getJob(history.key).state, 'parsed', 'a refused request changed nothing');
  assert.equal(persistence.operatorDispositions.length, 0);
  assert.throws(() => persistence.recordOperatorDisposition(history.key, { kind: 'refresh', operatorId: OPERATOR, reason: 'r' }), /recorded with requestRefresh/);
  assert.deepEqual(request([history.key, history.key]), { requested: 1 });
  assert.throws(() => request([history.key]), /retry_wait/, 'a page waiting for its refresh is not asked again');
});

test('the review command refuses refresh-season for an operator who is not listed, and without the worker configuration', async () => {
  const { runCli } = await import('../src/application/cli.mjs');
  const run = async (env) => {
    const errors = [];
    const result = await runCli({ mode: 'review', args: ['refresh-season', '--operator', 'ops', '--reason', 'new season'], env: { PERSISTENCE: 'postgres', PGHOST: 'db.example', PGDATABASE: 'scraper', PGUSER: 'scraper', ...env },
      stdout() {}, stderr: (line) => errors.push(line), openPostgres: async () => { throw new Error('the database must not be opened'); } });
    return { ...result, errors };
  };
  const unlisted = await run({ OPERATOR_IDS: 'someone-else' });
  assert.equal(unlisted.exitCode, 3);
  assert.match(unlisted.errors.join('\n'), /OPERATOR_IDS does not list operator ops/);
  const unconfigured = await run({ OPERATOR_IDS: 'ops' });
  assert.equal(unconfigured.exitCode, 3);
  assert.match(unconfigured.errors.join('\n'), /review configuration rejected/);
});

// #165: the schools active in 2026-27 over the seasons before it.
const applicationWithFinal = (shared, entries, targetFinalYear) => createFixtureApplication({
  fixtureEntries: entries, pinSeason: null, targetFinalYear,
  sharedState: { persistence: shared.persistence, rawStore: shared.rawStore, clock: shared.clock, sleep: shared.sleep },
});

// The rolled corpus, with school A's history also linking 2022, the oldest season of the window.
function corpusWith2022() {
  const entry = (path, document) => ({ url: `${ORIGIN}${path}`, body: `<!doctype html><html><body><script id="fixture-document" type="application/json">${JSON.stringify(document).replaceAll('<', '\u003c')}</script></body></html>` });
  const added = [
    entry('/school/a/men/', schoolHistoryDocument([2027, 2026, 2024, 2022].map((endingYear) => ({ endingYear, url: `/school/a/men/${endingYear}.html` })))),
    entry('/school/a/men/2022.html', seasonDocument({ school: 'Fixture A', endingYear: 2022, gameLogUrl: '/school/a/men/2022-gamelogs.html', games: [] })),
    entry('/school/a/men/2022-gamelogs.html', gameLogDocument(2022, [])),
  ];
  const urls = new Set(added.map((item) => item.url));
  return [...rolledFoundationCorpus().filter((item) => !urls.has(item.url)), ...added];
}

test('a crawl started after the rollover loads the schools active now over the seasons before this one (#165)', async () => {
  const shared = world('2026-11-03T00:00:00Z');
  const events = [];
  const app = createFixtureApplication({
    fixtureEntries: corpusWith2022(), pinSeason: null, targetFinalYear: 2026,
    events: { emit: (name, fields) => events.push([name, fields]) },
    sharedState: { persistence: shared.persistence, rawStore: shared.rawStore, clock: shared.clock, sleep: shared.sleep },
  });
  await app.runWorkerOnce();
  const { persistence } = shared;
  assert.deepEqual(events.find(([name]) => name === 'crawl.season')?.[1], { seasonEndingYear: 2027, targetFinalEndingYear: 2026, source: 'clock' });
  assert.deepEqual([...(await persistence.crawlScope()).endingYears], [2022, 2023, 2024, 2025, 2026]);
  const jobs = persistence.listJobs();
  assert.ok(jobs.every((job) => job.state === 'parsed'), `every page is parsed: ${JSON.stringify(jobs.filter((job) => job.state !== 'parsed').map((job) => [job.key, job.state]))}`);
  const seasonYears = new Set(jobs.filter((job) => job.pageType === 'season').map((job) => Number(/(\d{4})\.html/.exec(job.sourceUrl.absoluteUrl)[1])));
  assert.ok(seasonYears.has(2022) && seasonYears.has(2026) && !seasonYears.has(2027), `season pages ${[...seasonYears]}: 2022 and 2026 are loaded and 2027 is not`);
  assert.equal(jobs.filter((job) => job.pageType === 'school_history').length, 2, 'the two schools active in 2026-27; the one that ended in 2025 is not crawled');
  const report = await app.reconcile();
  assert.deepEqual(report.checks.filter((check) => !check.passed).map((check) => [check.id, check.records.slice(0, 2)]), [], 'the store reconciles against the window it was crawled under');
});

test('refresh-season widens the scope to the season once the target final season is unset (#165)', async () => {
  const shared = world('2026-11-03T00:00:00Z');
  await applicationWithFinal(shared, rolledFoundationCorpus(), 2026).runWorkerOnce();
  const rootKey = shared.persistence.listJobs().find((job) => job.pageType === 'school_index').key;
  const kept = await refresh(shared, rootKey, { dryRun: true, force: true, targetFinalYear: 2026 });
  assert.deepEqual(kept.addedYears, [], 'still ending at 2026, nothing is added');
  const unset = await refresh(shared, rootKey, { dryRun: true, force: true });
  assert.deepEqual(unset.addedYears, [2027], 'unset, the window moves on to 2027');
});
