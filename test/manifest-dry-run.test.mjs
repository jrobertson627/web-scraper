import test from 'node:test';
import assert from 'node:assert/strict';
import { createFixtureApplication } from '../src/application/composition-root.mjs';
import { EXIT_CODES, runCli } from '../src/application/cli.mjs';
import { MANIFEST_ESTIMATES, buildManifestReport, formatManifestReport } from '../src/application/manifest.mjs';
import { CRAWL_STAGES, assertCrawlStage } from '../src/contracts/crawl-scope.mjs';
import { validateConfiguration } from '../src/config/configuration.mjs';
import { foundationCorpus } from '../fixtures/foundation-corpus.mjs';

const ORIGIN = 'https://fixture.example';

async function manifestRun() {
  const app = createFixtureApplication({ fixtureEntries: foundationCorpus() });
  await app.runWorkerOnce('manifest-worker', { pageTypes: CRAWL_STAGES.manifest });
  return app;
}

test('a manifest run fetches only the school index and history pages and leaves the seasons queued', async () => {
  const app = await manifestRun();
  assert.deepEqual(app.transport.calls, [`${ORIGIN}/cbb/schools/`, `${ORIGIN}/school/a/men/`, `${ORIGIN}/school/b/men/`]);
  const seasons = app.persistence.listJobs().filter((job) => job.pageType === 'season');
  assert.equal(seasons.length, 3);
  assert.ok(seasons.every((job) => job.state === 'pending'), 'no season is fetched');
  // The long-running loop stops too: nothing it may claim remains, though seasons wait.
  const { orchestrator } = app;
  const result = await orchestrator.run({ workerId: 'manifest-worker', pageTypes: CRAWL_STAGES.manifest, sleep: async () => { throw new Error('should not idle'); } });
  assert.equal(result.processed, 0);
  assert.deepEqual(app.persistence.workOutlook({ pageTypes: CRAWL_STAGES.manifest }), { remaining: 0, wakeInMs: null });
  assert.equal(app.persistence.workOutlook().remaining, 3, 'a full run would still have the seasons');
});

test('the manifest report counts schools, linked and unavailable seasons, URLs and projected runtime', async () => {
  const app = await manifestRun();
  const report = await buildManifestReport(app.persistence);
  assert.equal(report.complete, true);
  assert.equal(report.scope.kind, 'full');
  assert.deepEqual(report.schools, { indexRows: 3, eligible: 2, histories: { discovered: 2, parsed: 2, failed: 0 } });
  assert.deepEqual(report.seasons, { linked: 3, unavailable: 7, unavailableBySchool: [
    { schoolSourcePath: 'fixture-provider:fixture.example/school/a', endingYears: [2022, 2023, 2025] },
    { schoolSourcePath: 'fixture-provider:fixture.example/school/b', endingYears: [2022, 2023, 2024, 2025] },
  ] });
  const boxScores = Math.round(3 * MANIFEST_ESTIMATES.boxScoresPerSeason);
  assert.deepEqual(report.urls, { discovered: 6, fetched: 3, projected: 1 + 2 + 3 + 3 + boxScores,
    projectedByPageType: { school_index: 1, school_history: 2, season: 3, game_log: 3, box_score: boxScores }, boxScoreBasis: 'estimate' });
  assert.equal(report.projection.remainingRequests, report.urls.projected - 3);
  assert.equal(report.projection.hoursAtPolicyPace, Math.round((report.projection.remainingRequests * 6000 / 3_600_000) * 10) / 10);
  assert.ok(report.projection.rawStorageBytes > 0);
  const text = formatManifestReport(report);
  assert.match(text, /manifest dry run: complete/);
  assert.match(text, /2 eligible of 3 index rows/);
  assert.match(text, /school\/b: 2022, 2023, 2024, 2025/);
});

test('a later full run continues from the manifest, and the report then counts discovered box scores', async () => {
  const app = await manifestRun();
  const manifestRequests = app.transport.calls.length;
  await app.runWorkerOnce();
  assert.ok(app.persistence.listJobs().every((job) => job.state === 'parsed'));
  assert.equal(new Set(app.transport.calls).size, app.transport.calls.length, 'no page is fetched twice');
  assert.ok(app.transport.calls.length > manifestRequests);
  const report = await buildManifestReport(app.persistence);
  assert.equal(report.urls.boxScoreBasis, 'discovered');
  assert.equal(report.urls.projected, report.urls.discovered);
  assert.equal(report.projection.remainingRequests, 0);
});

test('the crawl stage is full or manifest', () => {
  assert.equal(assertCrawlStage(undefined), 'full');
  assert.equal(assertCrawlStage('manifest'), 'manifest');
  assert.throws(() => assertCrawlStage('box_scores_only'), /crawl stage box_scores_only is invalid/);
  const base = { mode: 'local', providerId: 'p', allowedHosts: ['allowed.example'], rawStore: 'memory', publication: 'private',
    policy: { minIntervalMs: 6000, maxRequestsPerMinute: 10, hostConcurrency: 1, userAgent: 'scraper (+ops@example.com)' },
    eligibilityPredicate: 'To == CurrentSeasonEndingYear', currentSeasonEndingYear: 2026, targetEndingYears: [2022, 2023, 2024, 2025, 2026] };
  assert.equal(validateConfiguration(base).crawlStage, 'full');
  assert.equal(validateConfiguration({ ...base, crawlStage: 'manifest' }).crawlStage, 'manifest');
  assert.throws(() => validateConfiguration({ ...base, crawlStage: 'everything' }), /crawlStage is invalid/);
});

test('manifest mode prints the report from the durable store', async () => {
  const app = await manifestRun();
  const persistence = Object.assign(Object.create(app.persistence), { close: async () => {} });
  const output = [];
  const errors = [];
  const env = { PERSISTENCE: 'postgres', PGHOST: 'db.internal', PGDATABASE: 'scraper', PGUSER: 'scraper', PGPASSWORD: 'TOP_SECRET' };
  const run = (overrides, args = []) => runCli({ mode: 'manifest', env: { ...env, ...overrides }, args, stdout: (line) => output.push(line),
    stderr: (line) => errors.push(line), openPostgres: async () => persistence });
  assert.equal((await run({})).exitCode, EXIT_CODES.success);
  assert.match(output.at(-1), /manifest dry run: complete/);
  assert.equal((await run({}, ['--json'])).exitCode, EXIT_CODES.success);
  assert.equal(JSON.parse(output.at(-1)).seasons.linked, 3);
  assert.equal((await run({ PERSISTENCE: 'memory' })).exitCode, EXIT_CODES.configurationRejected);
  assert.equal((await run({}, ['--all'])).exitCode, EXIT_CODES.configurationRejected);
  assert.doesNotMatch(errors.join(' '), /TOP_SECRET/);
});
