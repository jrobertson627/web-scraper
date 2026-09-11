import { validateConfiguration } from '../config/configuration.mjs';
import { createSourceUrl, canonicalizeSourceUrl, sourceKey } from '../contracts/source.mjs';
import { FixtureTransport, Fetcher } from '../fetcher/index.mjs';
import { Discovery } from '../discovery/index.mjs';
import { FixtureParser, ParserRegistry } from '../parsers/index.mjs';
import { Normalizer } from '../domain/index.mjs';
import { InMemoryPersistence, createRawStore } from '../persistence/index.mjs';
import { createQueryService, createApiServer } from '../api/index.mjs';
import { ApplicationLifecycle } from './lifecycle.mjs';
import { IngestionOrchestrator } from './orchestrator.mjs';

const PROVIDER = 'fixture-provider';
const HOST = 'fixture.example';
const base = `https://${HOST}`;

function fixture(url, data) { return { url: `${base}${url}`, body: JSON.stringify(data) }; }

export function createFixtureApplication() {
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
  const persistence = new InMemoryPersistence(clock);
  const config = validateConfiguration({
    mode: 'local', providerId: PROVIDER, allowedHosts: [HOST], rawStore: 'memory',
    policy: { minIntervalMs: 6000, maxRequestsPerMinute: 10, hostConcurrency: 1, userAgent: 'web-scraper-fixture (+local@example.com)' },
    eligibilityPredicate: 'To == 2026', targetEndingYears: [2022, 2023, 2024, 2025, 2026],
    publication: 'private',
  });
  const rawStore = createRawStore(config.rawStore);
  const parsers = new ParserRegistry();
  for (const pageType of ['school_index', 'school_history', 'season', 'game_log', 'box_score']) parsers.register(new FixtureParser(pageType));
  const discovery = new Discovery({ providerId: PROVIDER, allowedHosts: [HOST], targetEndingYears: config.targetEndingYears });
  const fetcher = new Fetcher({ transport, rawStore, persistence, clock, sleep, policy: config.policy, allowedHosts: [HOST] });
  const normalizer = new Normalizer();
  const indexUrl = createSourceUrl(PROVIDER, `${base}/cbb/schools/`);
  const indexPath = canonicalizeSourceUrl(indexUrl);
  persistence.addJob({ key: sourceKey(indexPath, 'school_index'), pageType: 'school_index', sourceUrl: indexUrl, canonicalPath: indexPath });
  const orchestrator = new IngestionOrchestrator({ fetcher, discovery, parsers, normalizer, persistence, rawStore, clock });

  async function runWorkerOnce(workerId = 'fixture-worker') {
    const result = await orchestrator.runOnce(workerId);
    return { ...result, transportCalls: transport.calls.length };
  }

  return {
    config,
    lifecycle: new ApplicationLifecycle('local'),
    clock,
    transport,
    rawStore,
    persistence,
    orchestrator,
    runWorkerOnce,
    queries: createQueryService(persistence),
    createApiServer: (apiConfig = config) => createApiServer({ queries: createQueryService(persistence), config: apiConfig }),
  };
}
