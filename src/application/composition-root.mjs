import { validateConfiguration } from '../config/configuration.mjs';
import { sourceKey } from '../contracts/source.mjs';
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

export function createFixtureApplication({ sourceAdapter = new FixtureSourceAdapter() } = {}) {
  const adapter = assertSourceAdapter(sourceAdapter);
  const providerId = adapter.providerId();
  const indexUrl = adapter.indexUrl();
  const host = indexUrl.host;
  const base = new URL(indexUrl.absoluteUrl).origin;
  const fixture = (url, data) => ({ url: `${base}${url}`, body: JSON.stringify(data) });
  let currentTime = Date.parse('2026-01-01T00:00:00.000Z');
  const clock = () => new Date(currentTime);
  const sleep = async (milliseconds) => { currentTime += milliseconds; };
  const fixtureData = [
    fixture('/cbb/schools/', { schools: [{ path: '/school/a', name: 'Fixture A', to: 2026, historyUrl: `${base}/school/a/men/` }, { path: '/school/b', name: 'Fixture B', to: 2025, historyUrl: `${base}/school/b/men/` }] }),
    fixture('/school/a/men/', { seasons: [{ endingYear: 2026, url: `${base}/school/a/men/2026.html` }, { endingYear: 2024, url: `${base}/school/a/men/2024.html` }] }),
    fixture('/school/a/men/2026.html', { school: 'Fixture A', endingYear: 2026, gameLogUrl: `${base}/school/a/men/2026-gamelogs.html` }),
    fixture('/school/a/men/2024.html', { school: 'Fixture A', endingYear: 2024, gameLogUrl: `${base}/school/a/men/2024-gamelogs.html` }),
    fixture('/school/a/men/2026-gamelogs.html', { games: [{ boxScoreUrl: `${base}/box/one.html`, context: 'home', status: 'final' }] }),
    fixture('/school/a/men/2024-gamelogs.html', { games: [{ boxScoreUrl: `${base}/box/one.html`, context: 'away', status: 'final' }] }),
    fixture('/box/one.html', { date: '2026-01-02', home: 'Fixture A', away: 'Opponent', homeScore: 70, awayScore: 65, context: 'neutral', status: 'final', playerSourceId: null }),
  ];
  const transport = new FixtureTransport(new Map(fixtureData.map((item) => [item.url, item])));
  const config = validateConfiguration({
    mode: 'local', providerId, allowedHosts: [host], rawStore: 'memory',
    policy: { minIntervalMs: 6000, maxRequestsPerMinute: 10, hostConcurrency: 1, userAgent: 'web-scraper-fixture (+local@example.com)' },
    eligibilityPredicate: 'To == 2026', targetEndingYears: [2022, 2023, 2024, 2025, 2026],
    publication: 'private',
  }, { clock });
  const rawStore = createRawStore(config.rawStore);
  const persistence = new InMemoryPersistence(clock, { claimTimeoutMs: config.claimTimeoutMs });
  const parsers = new ParserRegistry();
  for (const pageType of ['school_index', 'school_history', 'season', 'game_log', 'box_score']) parsers.register(new FixtureParser(pageType));
  const discovery = new Discovery({ providerId, allowedHosts: [host], targetEndingYears: config.targetEndingYears });
  const fetcher = new Fetcher({ transport, rawStore, persistence, clock, sleep, policy: config.policy, allowedHosts: [host] });
  const normalizer = new Normalizer();
  const indexPath = adapter.canonicalize(indexUrl);
  const indexPageType = adapter.classify(indexUrl);
  persistence.addJob(createJob({ key: sourceKey(indexPath, indexPageType), pageType: indexPageType, sourceUrl: indexUrl, canonicalPath: indexPath }));
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
    queries,
    createApiServer: (apiConfig = config) => createApiServer({ queries, config: apiConfig, clock }),
  };
}
