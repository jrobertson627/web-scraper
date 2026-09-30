import test from 'node:test';
import assert from 'node:assert/strict';
import { IngestionOrchestrator } from '../src/application/orchestrator.mjs';
import { reprocessStoredPages } from '../src/application/reprocess.mjs';
import { SPORTS_REFERENCE_HOST, SportsReferenceSourceAdapter } from '../src/application/sports-reference-source-adapter.mjs';
import { createParseResult } from '../src/contracts/boundaries.mjs';
import { PAGE_TYPES, gameKey, sourceKey } from '../src/contracts/source.mjs';
import { targetEndingYearsFor } from '../src/contracts/season.mjs';
const TARGET_ENDING_YEARS = targetEndingYearsFor(2026);
import { Discovery } from '../src/discovery/index.mjs';
import { Normalizer } from '../src/domain/index.mjs';
import { Fetcher, FixtureTransport } from '../src/fetcher/index.mjs';
import { PRODUCTION_PARSERS, ParserRegistry, createProductionParserRegistry } from '../src/parsers/index.mjs';
import { InMemoryPersistence, MemoryRawStore } from '../src/persistence/index.mjs';
import { captureManifest, captureSkip, captureSourceUrl, readCapture } from '../fixtures/sports-reference/captures.mjs';

// Offline reprocessing of real Sports Reference snapshots (#43). The real
// fetcher path stores the captured pages (served by a fixture transport at
// their real URLs, so nothing leaves the machine), then a parser upgrade
// reprocesses what was stored. The captures are gitignored, so this skips
// without them; test/offline-reprocessing.test.mjs covers the same rules
// with synthetic pages.

const SITE_PATHS = Object.keys(captureManifest).filter((sitePath) => sitePath !== '/cbb/schools/');
const skip = captureSkip(...SITE_PATHS);
const adapter = new SportsReferenceSourceAdapter();
const policy = { minIntervalMs: 6000, maxRequestsPerMinute: 10, hostConcurrency: 1, userAgent: 'web-scraper-test (+ops@example.com)' };
const allVersions = (version) => Object.fromEntries(PAGE_TYPES.map((pageType) => [pageType, version]));

// The production parser at another version, with the same or a changed output.
function upgraded(parser, version, change = (document) => document) {
  return {
    pageType: () => parser.pageType(),
    version: () => version,
    parse: (snapshot) => {
      const result = parser.parse(snapshot);
      return result.kind === 'valid' ? createParseResult({ ...result, document: change(result.document) }) : result;
    },
  };
}

function captureJob(sitePath) {
  const sourceUrl = captureSourceUrl(sitePath);
  const canonicalPath = adapter.canonicalize(sourceUrl);
  const pageType = adapter.classify(sourceUrl);
  const school = /^\/cbb\/schools\/([^/]+)\/men\//.exec(sitePath)?.[1];
  return { key: sourceKey(canonicalPath, pageType), pageType, sourceUrl, canonicalPath,
    ...(school ? { schoolSourcePath: `sports-reference:${SPORTS_REFERENCE_HOST}/cbb/schools/${school}/men` } : {}) };
}

async function storedCaptures() {
  let time = Date.parse('2026-09-27T12:00:00.000Z');
  const clock = () => new Date(time);
  const persistence = new InMemoryPersistence(clock);
  const rawStore = new MemoryRawStore();
  const transport = new FixtureTransport(new Map(SITE_PATHS.map((sitePath) => [captureSourceUrl(sitePath).absoluteUrl, { body: readCapture(sitePath) }])));
  const discovery = new Discovery({ providerId: 'sports-reference', allowedHosts: [SPORTS_REFERENCE_HOST], targetEndingYears: TARGET_ENDING_YEARS, sourceAdapter: adapter });
  const normalizer = new Normalizer();
  const fetcher = new Fetcher({ transport, rawStore, persistence, clock, sleep: async (ms) => { time += ms; }, allowedHosts: [SPORTS_REFERENCE_HOST], policy });
  const orchestrator = new IngestionOrchestrator({ fetcher, discovery, parsers: createProductionParserRegistry(), normalizer, persistence, rawStore, clock });
  const jobs = SITE_PATHS.map(captureJob);
  for (const job of jobs) persistence.addJob(job);
  // Links to pages that were not captured get a 404 from the fixture transport.
  await orchestrator.runOnce('capture-worker');
  return { persistence, rawStore, transport, discovery, normalizer, clock, jobs };
}

const recordKey = (job) => (job.pageType === 'box_score' ? gameKey(job.canonicalPath) : job.key);

test('real stored snapshots reprocess under a new parser version with no request, and the version reaches every record', { skip }, async () => {
  const run = await storedCaptures();
  for (const job of run.jobs) assert.equal(run.persistence.getJob(job.key).state, 'parsed', job.key);
  const requests = run.transport.calls.length;
  const parsers = new ParserRegistry();
  for (const parser of PRODUCTION_PARSERS) parsers.register(parser).register(upgraded(parser, '2'));

  const summary = await reprocessStoredPages({ ...run, parsers, parserVersions: allVersions('2'), jobKeys: run.jobs.map((job) => job.key) });
  assert.equal(run.transport.calls.length, requests, 'no request is made');
  assert.equal(summary.accepted, run.jobs.length);
  assert.deepEqual([summary.conflicts, summary.parseFailures, summary.skipped], [0, 0, 0]);
  for (const job of run.jobs) {
    const runs = run.persistence.parseRuns.filter((entry) => entry.jobKey === job.key);
    assert.deepEqual(runs.map((entry) => entry.parserVersion), ['1', '2'], job.key);
    assert.equal(runs[1].sourceFetchId, runs[0].sourceFetchId, `${job.key} reparses the stored snapshot`);
    assert.equal(run.persistence.pages.get(recordKey(job)).provenance.parserVersion, '2', job.key);
  }
});

test('a real parser upgrade that changes its output supersedes the records it touches', { skip }, async () => {
  const run = await storedCaptures();
  const games = run.jobs.filter((job) => job.pageType === 'box_score');
  const before = new Map(games.map((job) => [job.key, run.persistence.pages.get(recordKey(job)).data]));
  const parsers = new ParserRegistry();
  for (const parser of PRODUCTION_PARSERS) parsers.register(parser);
  parsers.register(upgraded(PRODUCTION_PARSERS.find((parser) => parser.pageType() === 'box_score'), '2',
    (document) => ({ ...document, description: `${document.description ?? 'Regular season'} (v2)` })));

  const summary = await reprocessStoredPages({ ...run, parsers, parserVersions: { ...allVersions('1'), box_score: '2' }, pageTypes: ['box_score'] });
  assert.equal(summary.selected, games.length, 'only parsed box scores are selected');
  assert.equal(summary.superseded, games.length);
  assert.equal(summary.conflicts, 0);
  for (const job of games) {
    const page = run.persistence.pages.get(recordKey(job));
    assert.match(page.data.description, / \(v2\)$/);
    assert.deepEqual({ ...page.data, description: before.get(job.key).description }, before.get(job.key), 'only the changed field differs');
  }
});
