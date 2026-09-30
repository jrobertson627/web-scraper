import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixtureApplication } from '../src/application/composition-root.mjs';
import { IngestionOrchestrator } from '../src/application/orchestrator.mjs';
import { EXIT_CODES, parseReprocessArgs, runCli } from '../src/application/cli.mjs';
import { boxScoreDocument, gameLogDocument, schoolHistoryDocument, schoolIndexDocument, seasonDocument } from '../src/application/fixture-documents.mjs';
import { createJob, createNormalizedPage, createParseResult } from '../src/contracts/boundaries.mjs';
import { canTransition } from '../src/contracts/jobs.mjs';
import { createProvenance } from '../src/contracts/provenance.mjs';
import { PAGE_TYPES, canonicalizeSourceUrl, createSourceUrl, sourceKey } from '../src/contracts/source.mjs';
import { FixtureParser, ParserRegistry } from '../src/parsers/index.mjs';
import { InMemoryPersistence, MemoryRawStore } from '../src/persistence/index.mjs';
import { PostgresPersistence } from '../src/persistence/postgres.mjs';
import { foundationCorpus } from '../fixtures/foundation-corpus.mjs';

const ORIGIN = 'https://fixture.example';
const versions = (overrides = {}) => ({ ...Object.fromEntries(PAGE_TYPES.map((pageType) => [pageType, '1'])), ...overrides });

// A fixture parser at another version whose valid documents pass through `change`.
class UpgradedParser extends FixtureParser {
  constructor(pageType, version, change = (document) => document) { super(pageType, version); this.change = change; }
  parse(snapshot) {
    const result = super.parse(snapshot);
    return result.kind === 'valid' ? createParseResult({ ...result, document: this.change(result.document) }) : result;
  }
}

function registry(upgrades = {}) {
  const parsers = new ParserRegistry();
  for (const pageType of PAGE_TYPES) {
    parsers.register(new FixtureParser(pageType));
    if (upgrades[pageType]) parsers.register(new UpgradedParser(pageType, '2', upgrades[pageType]));
  }
  return parsers;
}

async function crawledCorpus(options) {
  const app = createFixtureApplication({ fixtureEntries: foundationCorpus(options) });
  await app.runWorkerOnce();
  return { app, transportCalls: app.transport.calls.length };
}

const parsedJobs = (app, pageType) => app.persistence.listJobs().filter((job) => job.pageType === pageType && job.state === 'parsed');

test('a parser upgrade reprocesses stored snapshots with no transport and supersedes the accepted records', async () => {
  const { app, transportCalls } = await crawledCorpus();
  const seasons = parsedJobs(app, 'season');
  assert.ok(seasons.length >= 2);
  const issuesBefore = app.persistence.reconciliationIssues.length;
  const summary = await app.reprocess({
    parsers: registry({ season: (document) => ({ ...document, school: `${document.school} (v2)` }) }),
    parserVersions: versions({ season: '2' }), pageTypes: ['season'],
  });

  assert.equal(app.transport.calls.length, transportCalls, 'reprocessing makes no request');
  assert.equal(summary.selected, seasons.length);
  assert.equal(summary.accepted, seasons.length);
  assert.equal(summary.superseded, seasons.length);
  assert.equal(summary.conflicts, 0);
  assert.deepEqual(summary.parserVersions, { season: { 2: seasons.length } });
  for (const job of seasons) {
    const page = app.persistence.pages.get(job.key);
    assert.match(page.data.school, / \(v2\)$/);
    assert.equal(page.provenance.parserVersion, '2', 'the new version reaches the normalized record');
    const runs = app.persistence.parseRuns.filter((run) => run.jobKey === job.key);
    assert.deepEqual(runs.map((run) => run.parserVersion), ['1', '2']);
    assert.equal(runs[1].sourceFetchId, runs[0].sourceFetchId, 'the same stored snapshot is parsed again');
  }
  assert.equal(app.persistence.reconciliationIssues.length, issuesBefore, 'a parser change is not a conflict');
  assert.equal(app.persistence.listJobs().every((job) => job.state !== 'pending'), true, 'no work is queued');
});

test('an unchanged re-parse under a new version is accepted and records the version', async () => {
  const { app, transportCalls } = await crawledCorpus();
  const games = parsedJobs(app, 'box_score');
  const summary = await app.reprocess({ parsers: registry({ box_score: (document) => document }), parserVersions: versions({ box_score: '2' }), pageTypes: ['box_score'] });
  assert.equal(app.transport.calls.length, transportCalls);
  assert.equal(summary.accepted, games.length);
  assert.equal(summary.superseded, 0, 'identical data needs no supersede');
  const gamePages = [...app.persistence.pages.values()].filter((page) => page.kind === 'game');
  assert.equal(gamePages.length, games.length);
  assert.ok(gamePages.every((page) => page.provenance.parserVersion === '2'));
  // Running it again is idempotent: the same version parses the same bytes to the same record.
  const again = await app.reprocess({ parsers: registry({ box_score: (document) => document }), parserVersions: versions({ box_score: '2' }), pageTypes: ['box_score'] });
  assert.equal(again.accepted, games.length);
  assert.equal(app.persistence.reconciliationIssues.length, 0);
});

test('a parser fix turns a parse_failed page into a parsed one and queues its children for the worker', async () => {
  const index = `${ORIGIN}/cbb/schools/`;
  const history = `${ORIGIN}/school/a/men/`;
  const season = `${ORIGIN}/school/a/men/2026.html`;
  const gameLog = `${ORIGIN}/school/a/men/2026-gamelogs.html`;
  const html = (document) => `<script id="fixture-document" type="application/json">${JSON.stringify(document)}</script>`;
  const app = createFixtureApplication({ fixtureEntries: [
    { url: index, body: html(schoolIndexDocument([{ path: '/school/a', name: 'Fixture A', to: 2026, historyUrl: history }])) },
    { url: history, body: html(schoolHistoryDocument([{ endingYear: 2026, url: season }])) },
    { url: season, body: html({ layoutShift: true }) },
    { url: gameLog, body: html(gameLogDocument(2026, [])) },
  ] });
  await app.runWorkerOnce();
  const seasonKey = sourceKey(canonicalizeSourceUrl(createSourceUrl('fixture-provider', season)), 'season');
  assert.equal(app.persistence.getJob(seasonKey).state, 'parse_failed');
  const calls = app.transport.calls.length;

  // v2 reads the shifted layout that v1 refused.
  const fixed = registry().register({ pageType: () => 'season', version: () => '2',
    parse: () => createParseResult({ kind: 'valid', document: seasonDocument({ school: 'Fixture A', endingYear: 2026, gameLogUrl: gameLog }) }) });
  // v2 of the other page types is not needed: only the parse_failed season is selected.
  const summary = await app.reprocess({ parsers: fixed, parserVersions: versions({ season: '2' }), states: ['parse_failed'] });
  assert.equal(summary.selected, 1);
  assert.equal(summary.promotedToParsed, 1);
  assert.equal(app.transport.calls.length, calls);
  const promoted = app.persistence.getJob(seasonKey);
  assert.equal(promoted.state, 'parsed');
  assert.deepEqual(promoted.history.at(-1).details, { reprocessed: true, parserVersion: '2' });
  const logKey = sourceKey(canonicalizeSourceUrl(createSourceUrl('fixture-provider', gameLog)), 'game_log');
  assert.equal(app.persistence.getJob(logKey).state, 'pending', 'the child the fixed page links to is queued');

  // The worker picks the child up; only then is a new request made.
  await app.runWorkerOnce();
  assert.equal(app.persistence.getJob(logKey).state, 'parsed');
  assert.deepEqual(app.transport.calls.slice(calls), [gameLog]);
});

test('a structural failure on reprocess is recorded and leaves the accepted record and state alone', async () => {
  const { app } = await crawledCorpus();
  const [season] = parsedJobs(app, 'season');
  const before = app.persistence.pages.get(season.key);
  const failing = new ParserRegistry().register(new FixtureParser('season'))
    .register({ pageType: () => 'season', version: () => '2', parse: () => createParseResult({ kind: 'structural_failure', error: 'v2 cannot read the roster' }) });
  const summary = await app.reprocess({ parsers: failing, parserVersions: versions({ season: '2' }), jobKeys: [season.key] });
  assert.equal(summary.parseFailures, 1);
  assert.deepEqual(summary.examples.parseFailures, [{ jobKey: season.key, reason: 'v2 cannot read the roster' }]);
  assert.equal(app.persistence.getJob(season.key).state, 'parsed');
  assert.equal(app.persistence.pages.get(season.key), before);
  assert.equal(app.persistence.parseRuns.at(-1).status, 'structural_failure');
  assert.equal(app.persistence.parseRuns.at(-1).parserVersion, '2');
});

test('only a parser change over the same raw body supersedes; a changed body is held as a conflict', () => {
  let now = new Date('2026-01-01T00:00:00Z');
  const persistence = new InMemoryPersistence(() => now);
  const rawStore = new MemoryRawStore();
  const sourceUrl = createSourceUrl('provider', 'https://allowed.example/box/one.html');
  const canonicalPath = canonicalizeSourceUrl(sourceUrl);
  persistence.addJob(createJob({ key: 'box', pageType: 'box_score', sourceUrl, canonicalPath }));
  const claimed = persistence.claimNextJob(now, 'worker');
  const original = rawStore.put(Buffer.from('original body'));
  const fetchA = persistence.recordFetch({ jobKey: 'box', status: 200, ...original }, claimed.lease, original);
  const page = (score) => createNormalizedPage({ jobKey: 'box', kind: 'game', identity: 'game', data: { score } });
  const provenance = (sourceFetchId, parserVersion) => createProvenance({ providerId: 'provider', canonicalPath, sourceUrl, sourceFetchId,
    parserName: 'box_score', parserVersion, parsedAt: now.toISOString() });
  persistence.transitionJob('box', 'fetched', claimed.lease);
  persistence.commitPageAndTransition(page(70), provenance(fetchA, '1'), claimed.lease);
  const run = (sourceFetchId, parserVersion) => ({ jobKey: 'box', sourceFetchId, parserName: 'box_score', parserVersion, status: 'valid', warnings: [], parsedAt: now.toISOString() });

  // The stored snapshot changed (a later fetch with another body): v2's different score is a conflict.
  const changed = rawStore.put(Buffer.from('corrected body'));
  persistence.sourceFetches.push(Object.freeze({ id: 'fetch-9', jobKey: 'box', status: 200, ...changed, fetchedAt: now.toISOString() }));
  const conflict = persistence.commitReprocess({ jobKey: 'box', parseRun: run('fetch-9', '2'), page: page(71), provenance: provenance('fetch-9', '2') });
  assert.equal(conflict.conflict, true);
  assert.equal(persistence.pages.get('game').data.score, 70);
  assert.equal(persistence.reconciliationIssues.length, 1);

  // A 304 re-recording the original body: v2 over the same bytes supersedes.
  now = new Date('2026-01-02T00:00:00Z');
  persistence.sourceFetches.push(Object.freeze({ id: 'fetch-10', jobKey: 'box', status: 304, ...original, reusedBody: true, fetchedAt: now.toISOString() }));
  const superseded = persistence.commitReprocess({ jobKey: 'box', parseRun: run('fetch-10', '2'), page: page(72), provenance: provenance('fetch-10', '2') });
  assert.deepEqual({ conflict: superseded.conflict, superseded: superseded.superseded }, { conflict: false, superseded: true });
  assert.equal(persistence.pages.get('game').data.score, 72);
  assert.equal(persistence.pages.get('game').provenance.parserVersion, '2');

  // Same parser, same bytes, different output cannot happen for a deterministic parser; it is a conflict.
  const sameVersion = persistence.commitReprocess({ jobKey: 'box', parseRun: run('fetch-10', '2'), page: page(73), provenance: provenance('fetch-10', '2') });
  assert.equal(sameVersion.conflict, true);
});

test('reprocessing refuses unsettled jobs and fetches of another job', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  const persistence = new InMemoryPersistence(() => now);
  const sourceUrl = createSourceUrl('provider', 'https://allowed.example/page');
  persistence.addJob(createJob({ key: 'job', pageType: 'season', sourceUrl, canonicalPath: canonicalizeSourceUrl(sourceUrl) }));
  const parseRun = { jobKey: 'job', sourceFetchId: 'fetch-1', parserName: 'season', parserVersion: '2', status: 'valid' };
  assert.throws(() => persistence.commitReprocess({ jobKey: 'job', parseRun }), /requires a parsed or parse_failed job. Current state: pending/);
  persistence.claimNextJob(now, 'worker');
  assert.throws(() => persistence.commitReprocess({ jobKey: 'job', parseRun }), /Current state: fetching/);
  assert.throws(() => persistence.commitReprocess({ jobKey: 'missing', parseRun }), /Current state: missing/);
  assert.equal(canTransition('parse_failed', 'parsed'), true);
  assert.equal(canTransition('parse_failed', 'fetching'), false, 'a worker still never claims parse_failed work');
  assert.throws(() => persistence.listJobsForReprocess({ states: ['pending'] }), /reprocess states are invalid/);
  assert.throws(() => persistence.listJobsForReprocess({ pageTypes: ['game'] }), /reprocess page types are invalid/);
});

test('settled jobs are listed for reprocessing in keyset pages', async () => {
  const { app } = await crawledCorpus({ faults: true });
  const settled = app.persistence.listJobs().filter((job) => ['parsed', 'parse_failed'].includes(job.state));
  const seen = [];
  let cursor = null;
  do {
    const page = app.persistence.listJobsForReprocess({ limit: 4, cursor });
    seen.push(...page.items.map((job) => job.key));
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(seen.sort(), settled.map((job) => job.key).sort());
  assert.deepEqual(app.persistence.listJobsForReprocess({ states: ['parse_failed'] }).items.map((job) => job.pageType), ['box_score']);
});

test('the worker parses each page type with its configured parser version', async () => {
  const now = new Date('2026-01-01T00:00:00Z');
  const persistence = new InMemoryPersistence(() => now);
  const sourceUrl = createSourceUrl('provider', 'https://allowed.example/box/one.html');
  // Queued before the upgrade, with the default version.
  persistence.addJob(createJob({ key: 'box', pageType: 'box_score', sourceUrl, canonicalPath: canonicalizeSourceUrl(sourceUrl) }));
  const body = Buffer.from(JSON.stringify(boxScoreDocument({ status: 'scheduled', away: { name: 'A' }, home: { name: 'B' } })));
  const orchestrator = new IngestionOrchestrator({
    fetcher: { fetch: async () => ({ kind: 'fetched', sourceFetchId: 'fetch-1', checksum: 'a'.repeat(64), body }) },
    parsers: new ParserRegistry().register(new UpgradedParser('box_score', '2')),
    parserVersions: versions({ box_score: '2' }),
    discovery: { discover: () => ({ observations: [], childJobs: [], unavailableCoverage: [], warnings: [] }) },
    normalizer: { normalize: (pageType, document, context) => createNormalizedPage({ jobKey: context.jobKey, kind: 'game', identity: 'game', data: document }) },
    persistence, rawStore: new MemoryRawStore(), clock: () => now,
  });
  await orchestrator.runOnce('worker');
  assert.equal(persistence.getJob('box').state, 'parsed');
  assert.equal(persistence.parseRuns[0].parserVersion, '2');
});

test('reprocess arguments select page types and states, or named jobs', () => {
  assert.deepEqual(parseReprocessArgs([]), {});
  assert.deepEqual(parseReprocessArgs(['--page-type', 'box_score,season', '--state', 'parse_failed', '--page-type', 'game_log']),
    { pageTypes: ['box_score', 'season', 'game_log'], states: ['parse_failed'] });
  assert.deepEqual(parseReprocessArgs(['--job', 'p:host/a:season', '--job', 'p:host/b:season']), { jobKeys: ['p:host/a:season', 'p:host/b:season'] });
  assert.throws(() => parseReprocessArgs(['--page-type']), /--page-type is invalid/);
  assert.throws(() => parseReprocessArgs(['--everything']), /--everything is invalid/);
  assert.throws(() => parseReprocessArgs(['--job', 'x', '--state', 'parsed']), /not both/);
  assert.throws(() => parseReprocessArgs(['--state', 'pending']), /--state pending is invalid/);
  assert.throws(() => parseReprocessArgs(['--page-type', 'game']), /--page-type game is invalid/);
});

const record = (name) => JSON.parse(readFileSync(new URL(`../config/personal-use.${name}.json`, import.meta.url), 'utf8'));

function reprocessEnv(overrides = {}) {
  const authorization = record('authorization');
  return {
    PROVIDER_ID: authorization.providerId, PROVIDER_HOST: authorization.scope.allowedHosts[0],
    USER_AGENT: 'web-scraper-test (+ops@example.com)', RAW_STORE_ROOT: mkdtempSync(join(tmpdir(), 'reprocess-cli-')),
    AUTHORIZATION_JSON: JSON.stringify(authorization), DATA_CONTRACT_JSON: JSON.stringify(record('data-contract')),
    PERSISTENCE: 'postgres', PGHOST: 'db.internal', PGDATABASE: 'scraper', PGUSER: 'scraper', PGPASSWORD: 'TOP_SECRET',
    ...overrides,
  };
}

// Reads answer from memory; the pool is never queried.
class EmptyPostgres extends PostgresPersistence {
  async rawStoreId() { return null; }
  async claimRawStoreId(storeId) { return storeId; }
  constructor() { super({ pool: { end: async () => {} } }); this.closed = 0; this.selections = []; }
  async listJobsForReprocess(selection) { this.selections.push(selection); return { items: [], nextCursor: null }; }
  async close() { this.closed += 1; }
}

test('reprocess mode needs PostgreSQL and a production parser for each configured version, and prints its summary', async () => {
  const errors = [];
  const output = [];
  const run = (env, args = []) => {
    const persistence = new EmptyPostgres();
    return runCli({ mode: 'reprocess', env, args, stdout: (line) => output.push(line), stderr: (line) => errors.push(line),
      crawlLog: { emit() {} }, openPostgres: async () => persistence }).then((result) => ({ ...result, persistence }));
  };

  assert.equal((await run(reprocessEnv({ PERSISTENCE: 'memory' }))).exitCode, EXIT_CODES.configurationRejected);
  assert.match(errors.at(-1), /reprocess needs the durable store/);
  assert.equal((await run(reprocessEnv({ PARSER_VERSIONS: '{"box_score":' }))).exitCode, EXIT_CODES.configurationRejected);
  assert.match(errors.at(-1), /PARSER_VERSIONS is invalid JSON/);
  assert.equal((await run(reprocessEnv(), ['--state', 'queued'])).exitCode, EXIT_CODES.configurationRejected);

  const missing = await run(reprocessEnv({ PARSER_VERSIONS: '{"box_score":"9"}' }));
  assert.equal(missing.exitCode, EXIT_CODES.workerNotReady);
  assert.match(errors.at(-1), /no production parser is registered for box_score@9/);
  assert.equal(missing.persistence.closed, 1);

  const done = await run(reprocessEnv(), ['--page-type', 'box_score', '--state', 'parse_failed']);
  assert.equal(done.exitCode, EXIT_CODES.success);
  assert.deepEqual(done.persistence.selections.map(({ pageTypes, states }) => ({ pageTypes, states })), [{ pageTypes: ['box_score'], states: ['parse_failed'] }]);
  assert.equal(JSON.parse(output.at(-1)).selected, 0);
  assert.equal(done.persistence.closed, 1);
  assert.doesNotMatch(errors.join(' '), /TOP_SECRET/);
});
