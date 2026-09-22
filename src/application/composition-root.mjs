import { validateConfiguration } from '../config/configuration.mjs';
import { createSourceUrl, sourceKey } from '../contracts/source.mjs';
import { assertSourceAdapter } from '../contracts/source-adapter.mjs';
import { assertBoundaryPort, createJob } from '../contracts/boundaries.mjs';
import { Fetcher } from '../fetcher/public.mjs';
import { FixtureTransport } from '../fetcher/index.mjs';
import { Discovery } from '../discovery/public.mjs';
import { ParserRegistry } from '../parsers/public.mjs';
import { FixtureParser } from '../parsers/index.mjs';
import { Normalizer } from '../domain/public.mjs';
import { createRawStore } from '../persistence/public.mjs';
import { InMemoryPersistence } from '../persistence/index.mjs';
import { createQueryService, createApiServer } from '../api/public.mjs';
import { ApplicationLifecycle } from './lifecycle.mjs';
import { IngestionOrchestrator } from './orchestrator.mjs';
import { FixtureSourceAdapter } from './fixture-source-adapter.mjs';
import { buildFixtureReconciliationReport } from './reconciliation.mjs';

export function createFixtureApplication({ sourceAdapter = new FixtureSourceAdapter(), fixtureEntries, sharedState } = {}) {
  const adapter = assertSourceAdapter(sourceAdapter);
  const providerId = adapter.providerId();
  const indexUrl = adapter.indexUrl();
  const host = indexUrl.host;
  const base = new URL(indexUrl.absoluteUrl).origin;
  const fixture = (url, data) => ({ url: `${base}${url}`, body: JSON.stringify(data) });
  let currentTime = Date.parse('2026-01-01T00:00:00.000Z');
  const clock = sharedState?.clock ?? (() => new Date(currentTime));
  const sleep = sharedState?.sleep ?? (async (milliseconds) => { currentTime += milliseconds; });
  const fixtureData = [
    fixture('/cbb/schools/', { schools: [{ path: '/school/a', name: 'Fixture A', to: 2026, historyUrl: `${base}/school/a/men/` }, { path: '/school/b', name: 'Fixture B', to: 2025, historyUrl: `${base}/school/b/men/` }] }),
    fixture('/school/a/men/', { seasons: [{ endingYear: 2026, url: `${base}/school/a/men/2026.html` }, { endingYear: 2024, url: `${base}/school/a/men/2024.html` }] }),
    fixture('/school/a/men/2026.html', { school: 'Fixture A', endingYear: 2026, gameLogUrl: `${base}/school/a/men/2026-gamelogs.html` }),
    fixture('/school/a/men/2024.html', { school: 'Fixture A', endingYear: 2024, gameLogUrl: `${base}/school/a/men/2024-gamelogs.html` }),
    fixture('/school/a/men/2026-gamelogs.html', { games: [{ boxScoreUrl: `${base}/box/one.html`, context: 'home', status: 'final' }] }),
    fixture('/school/a/men/2024-gamelogs.html', { games: [{ boxScoreUrl: `${base}/box/one.html`, context: 'away', status: 'final' }] }),
    fixture('/box/one.html', { date: '2026-01-02', home: 'Fixture A', away: 'Opponent', homeScore: 70, awayScore: 65, context: 'neutral', status: 'final', playerSourceId: null }),
  ];
  const fixtureMap = new Map((fixtureEntries ?? fixtureData).map((item) => [item.url, item]));
  const transport = sharedState?.transport ?? new FixtureTransport(fixtureMap);
  const config = validateConfiguration({
    mode: 'local', providerId, allowedHosts: [host], rawStore: 'memory',
    policy: { minIntervalMs: 6000, maxRequestsPerMinute: 10, hostConcurrency: 1, userAgent: 'web-scraper-fixture (+local@example.com)' },
    eligibilityPredicate: 'To == 2026', targetEndingYears: [2022, 2023, 2024, 2025, 2026],
    publication: 'private',
  }, { clock });
  const rawStore = sharedState?.rawStore ?? createRawStore(config.rawStore, config.rawStoreRoot);
  const persistence = sharedState?.persistence ?? new InMemoryPersistence(clock, { claimTimeoutMs: config.claimTimeoutMs });
  const parsers = new ParserRegistry();
  for (const pageType of ['school_index', 'school_history', 'season', 'game_log', 'box_score']) parsers.register(new FixtureParser(pageType));
  const discovery = new Discovery({ providerId, allowedHosts: [host], targetEndingYears: config.targetEndingYears });
  const fetcher = new Fetcher({ transport, rawStore, persistence, clock, sleep, policy: config.policy, allowedHosts: [host] });
  const normalizer = new Normalizer();
  const indexPath = adapter.canonicalize(indexUrl);
  const indexPageType = adapter.classify(indexUrl);
  const rootJob = createJob({ key: sourceKey(indexPath, indexPageType), pageType: indexPageType, sourceUrl: indexUrl, canonicalPath: indexPath });
  persistence.addJob(rootJob);
  const boundaryPorts = {
    fetcher: assertBoundaryPort('fetcher', fetcher),
    discovery: assertBoundaryPort('discovery', discovery),
    parsers: assertBoundaryPort('parsers', parsers),
    domain: assertBoundaryPort('domain', normalizer),
    persistence: assertBoundaryPort('persistence', persistence),
  };
  const queries = assertBoundaryPort('api', createQueryService(persistence));
  const orchestrator = new IngestionOrchestrator({
    fetcher: boundaryPorts.fetcher,
    discovery: boundaryPorts.discovery,
    parsers: boundaryPorts.parsers,
    normalizer: boundaryPorts.domain,
    persistence: boundaryPorts.persistence,
    rawStore,
    clock,
  });

  async function runWorkerOnce(workerId = 'fixture-worker') {
    const result = await orchestrator.runOnce(workerId);
    return { ...result, transportCalls: transport.calls.length };
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
    orchestrator,
    runWorkerOnce,
    previewDryRun,
    reconcile: () => buildFixtureReconciliationReport(persistence),
    queries,
    createApiServer: (apiConfig = config) => createApiServer({ queries, config: apiConfig, clock }),
  };
}
