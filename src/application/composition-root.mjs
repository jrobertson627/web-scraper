import { validateConfiguration } from '../config/configuration.mjs';
import { createSourceUrl, canonicalizeSourceUrl, sourceKey } from '../contracts/source.mjs';
import { FixtureTransport, Fetcher } from '../fetcher/index.mjs';
import { Discovery } from '../discovery/index.mjs';
import { FixtureParser, ParserRegistry } from '../parsers/index.mjs';
import { Normalizer } from '../domain/index.mjs';
import { InMemoryPersistence, MemoryRawStore } from '../persistence/index.mjs';
import { createQueryService, createApiServer } from '../api/index.mjs';
import { ApplicationLifecycle } from './lifecycle.mjs';

const PROVIDER = 'fixture-provider';
const HOST = 'fixture.example';
const base = `https://${HOST}`;

function fixture(url, data) { return { url: `${base}${url}`, body: JSON.stringify(data) }; }

export function createFixtureApplication() {
  const now = new Date('2026-01-01T00:00:00.000Z');
  const clock = () => now;
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
  const rawStore = new MemoryRawStore();
  const persistence = new InMemoryPersistence(clock);
  const config = validateConfiguration({
    mode: 'local', providerId: PROVIDER, allowedHosts: [HOST], rawStore: 'memory',
    policy: { minIntervalMs: 6000, maxRequestsPerMinute: 10, hostConcurrency: 1, userAgent: 'web-scraper-fixture (+local@example.com)' },
    eligibilityPredicate: 'To == 2026', targetEndingYears: [2022, 2023, 2024, 2025, 2026],
    publication: 'private',
  });
  const parsers = new ParserRegistry();
  for (const pageType of ['school_index', 'school_history', 'season', 'game_log', 'box_score']) parsers.register(new FixtureParser(pageType));
  const discovery = new Discovery({ providerId: PROVIDER, allowedHosts: [HOST], targetEndingYears: config.targetEndingYears });
  const fetcher = new Fetcher({ transport, rawStore, persistence, clock, policy: config.policy, allowedHosts: [HOST] });
  const normalizer = new Normalizer();
  const indexUrl = createSourceUrl(PROVIDER, `${base}/cbb/schools/`);
  const indexPath = canonicalizeSourceUrl(indexUrl);
  persistence.addJob({ key: sourceKey(indexPath, 'school_index'), pageType: 'school_index', sourceUrl: indexUrl, canonicalPath: indexPath });

  async function runWorkerOnce(workerId = 'fixture-worker') {
    let processed = 0;
    for (;;) {
      const job = persistence.claimNextJob(now, workerId);
      if (!job) break;
      const result = await fetcher.fetch(job, job.lease);
      if (result.kind === 'fetched' || result.kind === 'not_modified') {
        persistence.transitionJob(job.key, 'fetched', job.lease, { sourceFetchId: result.sourceFetchId });
        const snapshot = { jobKey: job.key, parentKey: job.parentKey, body: rawStore.get(result.checksum).body, sourceUrlFrom: (absoluteUrl) => createSourceUrl(PROVIDER, absoluteUrl) };
        const parsed = parsers.get(job.pageType).parse(snapshot);
        persistence.recordParse({ jobKey: job.key, parserName: job.pageType, parserVersion: parsers.get(job.pageType).version(), status: parsed.kind }, job.lease);
        if (parsed.kind === 'structural_failure') {
          persistence.transitionJob(job.key, 'parse_failed', job.lease, { failureReason: parsed.error });
        } else {
          const resultPage = discovery.discover(job.pageType, snapshot);
          const page = normalizer.normalize(job.pageType, parsed.document, { jobKey: job.key, canonicalPath: job.canonicalPath, observations: resultPage.observations });
          page.childJobs = resultPage.childJobs;
          page.unavailableCoverage = resultPage.unavailableCoverage;
          persistence.commitPage(page, { providerId: PROVIDER, canonicalPath: job.canonicalPath, sourceUrl: job.sourceUrl, sourceFetchId: result.sourceFetchId, parserName: job.pageType, parserVersion: '1', parsedAt: now.toISOString() }, job.lease);
          persistence.transitionJob(job.key, 'parsed', job.lease);
        }
      } else if (result.kind === 'retry_wait') {
        persistence.transitionJob(job.key, 'retry_wait', job.lease, { nextAllowedAt: now.toISOString(), lastError: result.reason });
      } else if (result.kind === 'operator_stop') {
        persistence.transitionJob(job.key, 'operator_stop', job.lease, { lastError: result.reason });
      } else {
        persistence.transitionJob(job.key, 'permanently_failed', job.lease, { lastError: result.reason });
      }
      processed += 1;
    }
    return { processed, jobs: persistence.listJobs(), transportCalls: transport.calls.length };
  }

  return { config, lifecycle: new ApplicationLifecycle('local'), clock, transport, rawStore, persistence, runWorkerOnce, queries: createQueryService(persistence), createApiServer: (apiConfig = config) => createApiServer({ queries: createQueryService(persistence), config: apiConfig }) };
}
