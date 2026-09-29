import { validateConfiguration } from '../config/configuration.mjs';
import { createSourceUrl, sourceKey } from '../contracts/source.mjs';
import { assertSourceAdapter } from '../contracts/source-adapter.mjs';
import { assertBoundaryPort, createJob } from '../contracts/boundaries.mjs';
import { Fetcher } from '../fetcher/public.mjs';
import { FixtureTransport } from '../fetcher/index.mjs';
import { HttpTransport } from '../fetcher/http-transport.mjs';
import { Discovery } from '../discovery/public.mjs';
import { ParserRegistry } from '../parsers/public.mjs';
import { FixtureParser, createProductionParserRegistry, missingProductionParsers } from '../parsers/index.mjs';
import { Normalizer } from '../domain/public.mjs';
import { createRawStore } from '../persistence/public.mjs';
import { FileRawStore, InMemoryPersistence } from '../persistence/index.mjs';
import { PostgresPersistence } from '../persistence/postgres.mjs';
import { createQueryService, createApiServer } from '../api/public.mjs';
import { ApplicationLifecycle } from './lifecycle.mjs';
import { IngestionOrchestrator } from './orchestrator.mjs';
import { FixtureSourceAdapter } from './fixture-source-adapter.mjs';
import { SportsReferenceSourceAdapter } from './sports-reference-source-adapter.mjs';
import { buildReconciliationReport } from './reconciliation.mjs';
import { reprocessStoredPages } from './reprocess.mjs';
import { acceptIssue, disposeJob, dismissIssue, listForReview, showReviewItem } from './review.mjs';
import { NO_CRAWL_EVENTS, jobStateCounts } from './crawl-log.mjs';
import { MAPPED_RETAINED_FIELDS } from '../contracts/retained-fields.mjs';
import {
  boxScoreDocument, gameLogDocument, schoolHistoryDocument, schoolIndexDocument, seasonDocument, statLine,
} from './fixture-documents.mjs';

// Tests and local mode only: fake time, fixture pages, in-memory persistence by
// default. A real crawl goes through createWorkerApplication. Local mode has no
// data contract, so retainedFields defaults to every mapped field.
export function createFixtureApplication({
  sourceAdapter = new FixtureSourceAdapter(), fixtureEntries, sharedState, events = NO_CRAWL_EVENTS,
  retainedFields = MAPPED_RETAINED_FIELDS, crawlScope,
} = {}) {
  if (sharedState?.transport instanceof HttpTransport) {
    throw new Error('fixture application refused the real HttpTransport: its fake clock would skip request pacing. Use createWorkerApplication for real requests.');
  }
  const adapter = assertSourceAdapter(sourceAdapter);
  const providerId = adapter.providerId();
  const indexUrl = adapter.indexUrl();
  const host = indexUrl.host;
  const base = new URL(indexUrl.absoluteUrl).origin;
  const fixture = (url, data) => ({ url: `${base}${url}`, body: JSON.stringify(data) });
  let currentTime = Date.parse('2026-01-01T00:00:00.000Z');
  const clock = sharedState?.clock ?? (() => new Date(currentTime));
  const sleep = sharedState?.sleep ?? (async (milliseconds) => { currentTime += milliseconds; });
  const home = { location: 'home', opponent: { name: 'Opponent', schoolPath: null }, boxScoreUrl: `${base}/box/one.html`, status: 'final',
    date: '2026-01-02', teamScore: 70, opponentScore: 65, teamStats: statLine({ pts: 70 }), opponentStats: statLine({ pts: 65 }) };
  const upcoming = { location: 'away', opponent: { name: 'Opponent', schoolPath: null }, status: 'scheduled' };
  const fixtureData = [
    fixture('/cbb/schools/', schoolIndexDocument([{ path: '/school/a', name: 'Fixture A', to: 2026, historyUrl: `${base}/school/a/men/` }, { path: '/school/b', name: 'Fixture B', to: 2025, historyUrl: `${base}/school/b/men/` }])),
    fixture('/school/a/men/', schoolHistoryDocument([{ endingYear: 2026, url: `${base}/school/a/men/2026.html` }, { endingYear: 2024, url: `${base}/school/a/men/2024.html` }])),
    fixture('/school/a/men/2026.html', seasonDocument({ school: 'Fixture A', endingYear: 2026, gameLogUrl: `${base}/school/a/men/2026-gamelogs.html`, games: [home] })),
    fixture('/school/a/men/2024.html', seasonDocument({ school: 'Fixture A', endingYear: 2024, gameLogUrl: `${base}/school/a/men/2024-gamelogs.html`, games: [upcoming] })),
    fixture('/school/a/men/2026-gamelogs.html', gameLogDocument(2026, [home])),
    fixture('/school/a/men/2024-gamelogs.html', gameLogDocument(2024, [upcoming])),
    fixture('/box/one.html', boxScoreDocument({ date: '2026-01-02', status: 'final',
      away: { name: 'Opponent', schoolPath: null, score: 65, stats: statLine({ pts: 65 }) },
      home: { name: 'Fixture A', schoolPath: '/school/a', score: 70, stats: statLine({ pts: 70 }) } })),
  ];
  const fixtureMap = new Map((fixtureEntries ?? fixtureData).map((item) => [item.url, item]));
  const transport = sharedState?.transport ?? new FixtureTransport(fixtureMap);
  const config = validateConfiguration({
    mode: 'local', providerId, allowedHosts: [host], rawStore: 'memory',
    policy: { minIntervalMs: 6000, maxRequestsPerMinute: 10, hostConcurrency: 1, userAgent: 'web-scraper-fixture (+local@example.com)' },
    eligibilityPredicate: 'To == 2026', targetEndingYears: [2022, 2023, 2024, 2025, 2026],
    publication: 'private', crawlScope,
  }, { clock });
  const rawStore = sharedState?.rawStore ?? createRawStore(config.rawStore, config.rawStoreRoot);
  const persistence = sharedState?.persistence ?? new InMemoryPersistence(clock, { claimTimeoutMs: config.claimTimeoutMs });
  const parsers = new ParserRegistry();
  for (const pageType of ['school_index', 'school_history', 'season', 'game_log', 'box_score']) parsers.register(new FixtureParser(pageType));
  const discovery = new Discovery({ providerId, allowedHosts: [host], targetEndingYears: config.targetEndingYears, scope: config.crawlScope });
  const fetcher = new Fetcher({ transport, rawStore, persistence, clock, sleep, policy: config.policy, allowedHosts: [host], events });
  const normalizer = new Normalizer({ retainedFields });
  const indexPath = adapter.canonicalize(indexUrl);
  const indexPageType = adapter.classify(indexUrl);
  const rootJob = createJob({ key: sourceKey(indexPath, indexPageType), pageType: indexPageType, sourceUrl: indexUrl, canonicalPath: indexPath });
  const ready = prepareCrawl({ persistence, scope: config.crawlScope, rootJob, events,
    rediscover: () => rediscoverStoredPages({ persistence, rawStore, parsers, discovery, normalizer, clock, parserVersions: config.parserVersions, events }) });
  ready.catch(() => {}); // awaited by runWorkerOnce, which reports a refusal
  const boundaryPorts = {
    fetcher: assertBoundaryPort('fetcher', fetcher),
    discovery: assertBoundaryPort('discovery', discovery),
    parsers: assertBoundaryPort('parsers', parsers),
    domain: assertBoundaryPort('domain', normalizer),
    persistence: assertBoundaryPort('persistence', persistence),
  };
  const queries = assertBoundaryPort('api', createQueryService(persistence, { retainedFields }));
  const orchestrator = new IngestionOrchestrator({
    fetcher: boundaryPorts.fetcher,
    discovery: boundaryPorts.discovery,
    parsers: boundaryPorts.parsers,
    normalizer: boundaryPorts.domain,
    persistence: boundaryPorts.persistence,
    rawStore,
    clock,
    events,
    parserVersions: config.parserVersions,
  });

  // pageTypes limits the run (CRAWL_STAGES.manifest for a manifest dry run, #44).
  async function runWorkerOnce(workerId = 'fixture-worker', { pageTypes } = {}) {
    await ready;
    const result = await orchestrator.runOnce(workerId, { pageTypes });
    // The fixture corpus is small, so the local run still reports every job.
    const jobs = await persistence.listJobs();
    events.summary?.({ jobStates: jobStateCounts(jobs) });
    return { ...result, jobs, transportCalls: transport.calls.length };
  }

  function previewDryRun() {
    const queue = [rootJob];
    const seen = new Set();
    const boxScoreLinks = new Set();
    const pageTypes = {};
    let unavailableCoverage = 0;
    while (queue.length) {
      const job = queue.shift();
      if (seen.has(job.key)) continue;
      seen.add(job.key);
      pageTypes[job.pageType] = (pageTypes[job.pageType] ?? 0) + 1;
      const entry = fixtureMap.get(job.sourceUrl.absoluteUrl);
      if (!entry) continue;
      const snapshot = {
        jobKey: job.key, parentKey: job.parentKey, schoolSourcePath: job.schoolSourcePath,
        sourceUrl: job.sourceUrl, body: Buffer.from(entry.body),
        sourceUrlFrom: (target, baseUrl = job.sourceUrl.absoluteUrl) => createSourceUrl(providerId, target, baseUrl),
      };
      const parsed = parsers.parse(job.pageType, '1', snapshot);
      if (parsed.kind !== 'valid') continue;
      const discovered = discovery.discover(job.pageType, snapshot, parsed.document);
      unavailableCoverage += discovered.unavailableCoverage.length;
      for (const child of discovered.childJobs) {
        if (child.pageType === 'box_score') boxScoreLinks.add(child.key);
        else queue.push(child);
      }
    }
    return Object.freeze({
      uniquePreBackfillUrls: seen.size,
      boxScoreLinks: boxScoreLinks.size,
      unavailableCoverage,
      pageTypes: Object.freeze(pageTypes),
      estimatedMinimumRuntimeMs: Math.max(0, seen.size - 1) * config.policy.minIntervalMs,
    });
  }

  return {
    config,
    sourceAdapter: adapter,
    lifecycle: new ApplicationLifecycle('local'),
    clock,
    transport,
    rawStore,
    persistence,
    ready,
    orchestrator,
    runWorkerOnce,
    previewDryRun,
    // Operator review (#48) over the fixture store; the persistence must be
    // given an operator authorizer (sharedState.persistence) for actions.
    review: reviewOperations({ persistence, rawStore, parsers, discovery, normalizer, clock }),
    // Offline reprocessing of the stored snapshots (#43). Tests pass an upgraded
    // parser registry and versions; no transport is involved.
    reprocess: ({ parsers: registry = parsers, parserVersions = config.parserVersions, ...selection } = {}) => reprocessStoredPages({
      persistence, rawStore, parsers: registry, discovery, normalizer, clock, parserVersions, events, ...selection,
    }),
    // The fixture corpus exercises every value state and game status, so the
    // coverage invariants are required here (see reconciliation.mjs).
    reconcile: async () => {
      const report = await buildReconciliationReport(persistence, { requireCoverage: true });
      events.emit('reconciliation.completed', { passed: report.passed,
        failedChecks: report.checks.filter((check) => !check.passed).length, quarantined: report.quarantined.length });
      return report;
    },
    queries,
    createApiServer: (apiConfig = config) => createApiServer({ queries, config: apiConfig, clock }),
  };
}

// Before a crawl starts (#78): record the scope it runs under, which refuses a
// narrower one than the store already holds; when the scope widened (a sample
// becoming the full crawl), run discovery again over the stored index and
// history pages, so the schools and years now in scope are queued without a
// request; then queue the school index.
//
// With the in-memory store the steps run synchronously (the root job is queued
// when the fixture application is built, as before); a promise is always returned.
function prepareCrawl({ persistence, scope, rootJob, rediscover, events }) {
  const finish = (recorded) => {
    events.emit('crawl.scope', { kind: recorded.scope.kind, schools: recorded.scope.schools?.length ?? null,
      endingYears: recorded.scope.endingYears, widened: recorded.widened });
    const queue = () => Promise.resolve(persistence.addJob(rootJob)).then(() => recorded);
    return recorded.widened ? rediscover().then(queue) : queue();
  };
  try {
    const recorded = persistence.recordCrawlScope(scope);
    return typeof recorded?.then === 'function' ? recorded.then(finish) : finish(recorded);
  } catch (error) {
    return Promise.reject(error);
  }
}

function rediscoverStoredPages(parts) {
  return reprocessStoredPages({ ...parts, pageTypes: ['school_index', 'school_history'], states: ['parsed'] });
}

export const systemClock = () => new Date();
export const realSleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const CLOCK_DRIFT_LIMIT_MS = 5_000;
const SLEEP_PROBE_MS = 40;

// Proves the injected clock reads wall time and sleep(ms) really waits while the
// clock advances with it. A fake sleep would let paced requests go out back to
// back and write fake timestamps to the host request schedule.
export async function assertRealTime({ clock, sleep } = {}) {
  if (typeof clock !== 'function' || typeof sleep !== 'function') throw new Error('real time check requires clock() and sleep(ms) functions');
  const drift = Math.abs(clock().getTime() - Date.now());
  if (!(drift <= CLOCK_DRIFT_LIMIT_MS)) throw new Error(`clock is ${Number.isNaN(drift) ? 'invalid' : `${drift}ms away from system time`}; a real crawl needs the system clock`);
  const started = performance.now();
  const before = clock().getTime();
  await sleep(SLEEP_PROBE_MS);
  const waited = performance.now() - started;
  const advanced = clock().getTime() - before;
  if (waited < SLEEP_PROBE_MS / 2) throw new Error(`sleep(${SLEEP_PROBE_MS}) returned after ${Math.round(waited)}ms; a real crawl needs a sleep that waits`);
  if (advanced < SLEEP_PROBE_MS / 2) throw new Error(`clock advanced ${advanced}ms across a ${Math.round(waited)}ms sleep; a real crawl needs the system clock`);
}

// Production assembly for worker mode (#36). It accepts only real parts: the
// system clock and sleep, HttpTransport, PostgresPersistence, a filesystem raw
// store, a production parser for every page type, and a source adapter matching
// the authorized provider. The configuration is validated here in worker mode,
// so the authorization and data-contract gate must pass before anything is built.
// events is the crawl-log sink (crawl-log.mjs) for the fetcher and orchestrator.
export async function createWorkerApplication({
  config: configInput,
  sourceAdapter = new SportsReferenceSourceAdapter(),
  transport,
  persistence,
  rawStore,
  parsers = createProductionParserRegistry(),
  clock = systemClock,
  sleep = realSleep,
  events = NO_CRAWL_EVENTS,
} = {}) {
  const refuse = (reason) => new Error(`worker assembly refused: ${reason}`);
  if (!(transport instanceof HttpTransport)) throw refuse('transport must be HttpTransport; fixture and stub transports belong to createFixtureApplication');
  try {
    await assertRealTime({ clock, sleep });
  } catch (error) {
    throw refuse(error.message);
  }
  const config = validateConfiguration(configInput, { clock });
  if (config.mode !== 'worker') throw refuse(`configuration mode is ${config.mode}, expected worker`);
  const adapter = assertSourceAdapter(sourceAdapter);
  const providerId = adapter.providerId();
  if (providerId !== config.providerId) throw refuse(`source adapter provider ${providerId} does not match configured provider ${config.providerId}`);
  const indexUrl = adapter.indexUrl();
  if (!config.allowedHosts.includes(indexUrl.host)) throw refuse(`source adapter host ${indexUrl.host} is not in allowedHosts`);
  if (!(persistence instanceof PostgresPersistence)) throw refuse('persistence must be PostgresPersistence');
  const store = rawStore ?? createRawStore(config.rawStore, config.rawStoreRoot);
  if (!(store instanceof FileRawStore)) throw refuse('raw store must be the filesystem raw store');
  if (!(parsers instanceof ParserRegistry)) throw refuse('parsers must be a ParserRegistry');
  const missing = missingProductionParsers(parsers, config.parserVersions);
  if (missing.length) throw refuse(`no production parser is registered for ${missing.join(', ')}`);

  const discovery = new Discovery({ providerId, allowedHosts: config.allowedHosts, targetEndingYears: config.targetEndingYears, sourceAdapter: adapter, scope: config.crawlScope, minEligibleSchools: config.minEligibleSchools });
  const fetcher = new Fetcher({ transport, rawStore: store, persistence, clock, sleep, policy: config.policy, allowedHosts: config.allowedHosts, events });
  // Only the data contract's retained fields are stored (#89).
  const normalizer = new Normalizer({ retainedFields: config.dataContract.retainedFields });
  const indexPath = adapter.canonicalize(indexUrl);
  const indexPageType = adapter.classify(indexUrl);
  const rootJob = createJob({ key: sourceKey(indexPath, indexPageType), pageType: indexPageType, sourceUrl: indexUrl, canonicalPath: indexPath });
  const orchestrator = new IngestionOrchestrator({
    fetcher: assertBoundaryPort('fetcher', fetcher),
    discovery: assertBoundaryPort('discovery', discovery),
    parsers: assertBoundaryPort('parsers', parsers),
    normalizer: assertBoundaryPort('domain', normalizer),
    persistence: assertBoundaryPort('persistence', persistence),
    rawStore: store,
    clock,
    events,
    parserVersions: config.parserVersions,
  });
  let seeded;
  // Records the crawl scope, rediscovers stored pages if it widened, and queues
  // the school index once; addJob keeps an existing root job as it is.
  const seedRootJob = () => {
    seeded ??= prepareCrawl({ persistence, scope: config.crawlScope, rootJob, events,
      rediscover: () => rediscoverStoredPages({ persistence, rawStore: store, parsers, discovery, normalizer, clock, parserVersions: config.parserVersions, events }) })
      .catch((error) => { seeded = undefined; throw error; });
    return seeded;
  };

  return {
    config,
    sourceAdapter: adapter,
    lifecycle: new ApplicationLifecycle('worker'),
    clock,
    sleep,
    transport,
    rawStore: store,
    persistence,
    parsers,
    events,
    orchestrator,
    rootJob,
    seedRootJob,
    async runWorkerOnce(workerId = 'worker') {
      await seedRootJob();
      return orchestrator.runOnce(workerId);
    },
  };
}

// Production assembly for offline reprocessing (#43, `cli.mjs reprocess`). It
// passes the same configuration gate as the worker, because it writes
// provider-derived records, and accepts the same durable parts, but it builds
// no Fetcher and takes no transport: it only reads stored raw snapshots.
export function createReprocessApplication({
  config: configInput,
  sourceAdapter = new SportsReferenceSourceAdapter(),
  persistence,
  rawStore,
  parsers = createProductionParserRegistry(),
  clock = systemClock,
  events = NO_CRAWL_EVENTS,
} = {}) {
  const refuse = (reason) => new Error(`reprocess assembly refused: ${reason}`);
  const config = validateConfiguration(configInput, { clock });
  if (config.mode !== 'worker') throw refuse(`configuration mode is ${config.mode}, expected worker`);
  const adapter = assertSourceAdapter(sourceAdapter);
  const providerId = adapter.providerId();
  if (providerId !== config.providerId) throw refuse(`source adapter provider ${providerId} does not match configured provider ${config.providerId}`);
  if (!(persistence instanceof PostgresPersistence)) throw refuse('persistence must be PostgresPersistence');
  const store = rawStore ?? createRawStore(config.rawStore, config.rawStoreRoot);
  if (!(store instanceof FileRawStore)) throw refuse('raw store must be the filesystem raw store');
  if (!(parsers instanceof ParserRegistry)) throw refuse('parsers must be a ParserRegistry');
  const missing = missingProductionParsers(parsers, config.parserVersions);
  // exit names the CLI exit code (EXIT_CODES.workerNotReady), as for the worker.
  if (missing.length) throw Object.assign(refuse(`no production parser is registered for ${missing.join(', ')}`), { exit: 'workerNotReady' });
  const discovery = assertBoundaryPort('discovery', new Discovery({ providerId, allowedHosts: config.allowedHosts, targetEndingYears: config.targetEndingYears, sourceAdapter: adapter, scope: config.crawlScope, minEligibleSchools: config.minEligibleSchools }));
  const normalizer = assertBoundaryPort('domain', new Normalizer({ retainedFields: config.dataContract.retainedFields }));
  return {
    config,
    persistence,
    rawStore: store,
    parsers,
    reprocess: ({ pageTypes, states, jobKeys } = {}) => reprocessStoredPages({
      persistence, rawStore: store, parsers, discovery, normalizer, clock, parserVersions: config.parserVersions, events,
      ...(pageTypes ? { pageTypes } : {}), ...(states ? { states } : {}), ...(jobKeys ? { jobKeys } : {}),
    }),
  };
}

// Operator review (#48): listing, inspecting and recording dispositions. accept
// derives the reviewed page again, so it needs the parsers, raw store,
// discovery and normalizer; without them only the other operations work.
function reviewOperations({ persistence, rawStore, parsers, discovery, normalizer, clock }) {
  return Object.freeze({
    list: (options = {}) => listForReview({ persistence, ...options }),
    show: (id) => showReviewItem({ persistence, id }),
    dispose: (jobKey, action, { operatorId, reason }) => disposeJob({ persistence, jobKey, action, operatorId, reason, clock }),
    dismiss: (issueId, { operatorId, reason }) => dismissIssue({ persistence, issueId, operatorId, reason, clock }),
    accept: (issueId, { operatorId, reason }) => {
      if (!parsers) throw new Error('accept needs the worker configuration: AUTHORIZATION_JSON, DATA_CONTRACT_JSON, RAW_STORE_ROOT and USER_AGENT, as for the worker');
      return acceptIssue({ persistence, rawStore, parsers, discovery, normalizer, clock, issueId, operatorId, reason });
    },
  });
}

// Production assembly for `cli.mjs review`. The persistence carries the
// operator authorizer (OPERATOR_IDS). With a worker configuration it can also
// accept quarantined revisions, which passes the worker's configuration gate
// because it commits provider-derived records; it never builds a transport.
export function createReviewApplication({
  persistence,
  config: configInput,
  sourceAdapter = new SportsReferenceSourceAdapter(),
  rawStore,
  parsers = createProductionParserRegistry(),
  clock = systemClock,
} = {}) {
  const refuse = (reason) => new Error(`review assembly refused: ${reason}`);
  if (!(persistence instanceof PostgresPersistence)) throw refuse('persistence must be PostgresPersistence');
  if (!configInput) return reviewOperations({ persistence, clock });
  const config = validateConfiguration(configInput, { clock });
  if (config.mode !== 'worker') throw refuse(`configuration mode is ${config.mode}, expected worker`);
  const adapter = assertSourceAdapter(sourceAdapter);
  if (adapter.providerId() !== config.providerId) throw refuse(`source adapter provider ${adapter.providerId()} does not match configured provider ${config.providerId}`);
  const store = rawStore ?? createRawStore(config.rawStore, config.rawStoreRoot);
  if (!(store instanceof FileRawStore)) throw refuse('raw store must be the filesystem raw store');
  if (!(parsers instanceof ParserRegistry)) throw refuse('parsers must be a ParserRegistry');
  const discovery = new Discovery({ providerId: config.providerId, allowedHosts: config.allowedHosts, targetEndingYears: config.targetEndingYears, sourceAdapter: adapter, scope: config.crawlScope, minEligibleSchools: config.minEligibleSchools });
  const normalizer = new Normalizer({ retainedFields: config.dataContract.retainedFields });
  return reviewOperations({ persistence, rawStore: store, parsers, discovery, normalizer, clock });
}
