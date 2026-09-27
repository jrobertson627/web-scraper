import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createFixtureApplication } from '../src/application/composition-root.mjs';
import { CRAWL_COUNTERS, createCrawlLog } from '../src/application/crawl-log.mjs';
import { formatCrawlStatus, summarizeCrawlStatus } from '../src/application/crawl-status.mjs';
import { runCli, EXIT_CODES } from '../src/application/cli.mjs';
import { Fetcher } from '../src/fetcher/index.mjs';
import { InMemoryPersistence, MemoryRawStore } from '../src/persistence/index.mjs';
import { canonicalizeSourceUrl, createSourceUrl } from '../src/contracts/source.mjs';
import { foundationCorpus } from '../fixtures/foundation-corpus.mjs';

function recordingLog(options) {
  const lines = [];
  const log = createCrawlLog({ write: (line) => lines.push(line), clock: () => new Date('2026-01-01T00:00:00Z'), ...options });
  return { log, lines, entries: () => lines.map((line) => JSON.parse(line)) };
}

test('a supervised fixture run produces a structured log covering requests, jobs, discovery and job states', async () => {
  const { log, entries } = recordingLog();
  const app = createFixtureApplication({ fixtureEntries: foundationCorpus({ faults: true }), events: log });
  const result = await app.runWorkerOnce();
  app.reconcile();
  const logged = entries();
  assert.ok(logged.every((entry) => typeof entry.at === 'string' && typeof entry.event === 'string'));
  const counters = log.counters();
  assert.deepEqual(Object.keys(counters), [...CRAWL_COUNTERS]);
  assert.equal(counters.requestsStarted, app.transport.calls.length);
  assert.equal(logged.filter((entry) => entry.event === 'request.started').length, app.transport.calls.length);
  assert.ok(counters.throttlePauses > 0, 'the 6 s request interval shows up as throttle pauses');
  assert.equal(counters.throttleWaitMs, logged.filter((entry) => entry.event === 'throttle.paused').reduce((sum, entry) => sum + entry.waitMs, 0));
  assert.equal(counters.parsed, result.jobs.filter((job) => job.state === 'parsed').length);
  assert.ok(counters.parseFailures >= 1, 'the layout-shifted box score is a parse failure');
  assert.ok(counters.duplicateDiscoveries >= 1, 'a box score linked from both teams is a duplicate discovery');
  assert.equal(counters.discoveredChildren + counters.duplicateDiscoveries,
    logged.filter((entry) => entry.event === 'page.discovered').reduce((sum, entry) => sum + entry.children, 0));
  assert.ok(counters.reconciliationFailures >= 1);
  const settled = logged.filter((entry) => entry.event === 'job.settled');
  assert.equal(settled.length, result.events.length);
  assert.ok(settled.every((entry) => entry.jobKey && entry.pageType && entry.kind && Number.isInteger(entry.warnings)));
  const summary = logged.findLast((entry) => entry.event === 'crawl.summary');
  assert.equal(summary.jobStates.parsed, counters.parsed);
  assert.equal(summary.counters.requestsStarted, counters.requestsStarted);
  assert.ok(summary.settledByPageType.box_score.parse_failed >= 1);
  assert.equal(logged.filter((entry) => entry.event === 'reconciliation.completed').length, 1);
  const text = logged.map((entry) => JSON.stringify(entry)).join('\n');
  assert.doesNotMatch(text, /web-scraper-fixture \(\+local@example\.com\)/, 'the user agent (a config value) is never logged');
});

test('retry waits and challenge stops are counted from settled jobs', async () => {
  for (const [status, counter, kind] of [[503, 'retryWaits', 'retry_wait'], [403, 'challengeStops', 'operator_stop']]) {
    const { log, entries } = recordingLog();
    const transport = { calls: [], async request({ url }) { this.calls.push(url); return { status, headers: {}, body: Buffer.alloc(0) }; } };
    const app = createFixtureApplication({ sharedState: { transport }, events: log });
    await app.runWorkerOnce();
    assert.equal(log.counters()[counter], 1, counter);
    const settled = entries().find((entry) => entry.event === 'job.settled');
    assert.equal(settled.kind, kind);
    if (status === 403) assert.equal(settled.code, 'challenge');
  }
});

test('cache hits and 304 revalidations are logged by the fetcher', async () => {
  let time = Date.parse('2026-01-01T00:00:00.000Z');
  const clock = () => new Date(time);
  const sleep = async (ms) => { time += ms; };
  const source = createSourceUrl('provider', 'https://allowed.example/page');
  const policy = { minIntervalMs: 6000, maxRequestsPerMinute: 10, hostConcurrency: 1, userAgent: 'scraper (+ops@example.com)' };
  const run = async (cacheMaxAgeMs) => {
    const persistence = new InMemoryPersistence(clock);
    const rawStore = new MemoryRawStore();
    const { log } = recordingLog();
    const transport = { async request({ headers }) {
      return headers['if-none-match'] === '"v1"' ? { status: 304, headers: { etag: '"v1"' }, body: Buffer.alloc(0) }
        : { status: 200, headers: { etag: '"v1"', 'cache-control': 'max-age=3600' }, body: Buffer.from('{}') };
    } };
    const fetcher = new Fetcher({ transport, rawStore, persistence, clock, sleep, allowedHosts: ['allowed.example'],
      policy: { ...policy, cacheMaxAgeMs }, events: log });
    persistence.addJob({ key: 'job', pageType: 'season', sourceUrl: source, canonicalPath: canonicalizeSourceUrl(source) });
    let claimed = persistence.claimNextJob(clock(), 'worker');
    assert.equal((await fetcher.fetch(claimed, claimed.lease)).kind, 'fetched');
    persistence.transitionJob('job', 'retry_wait', claimed.lease, { nextAllowedAt: clock().toISOString() });
    claimed = persistence.claimNextJob(clock(), 'worker');
    assert.equal((await fetcher.fetch(claimed, claimed.lease)).kind, 'not_modified');
    return log.counters();
  };
  const cached = await run(60_000);
  assert.deepEqual([cached.requestsStarted, cached.cacheHits, cached.notModified], [1, 1, 0]);
  const revalidated = await run(0);
  assert.deepEqual([revalidated.requestsStarted, revalidated.cacheHits, revalidated.notModified], [2, 0, 1]);
  assert.equal(revalidated.throttlePauses > 0, true);
});

test('crawl summaries are written periodically and a failing writer never stops the crawl', async () => {
  const { log, entries } = recordingLog({ summaryEvery: 2 });
  const app = createFixtureApplication({ events: log });
  const result = await app.runWorkerOnce();
  const summaries = entries().filter((entry) => entry.event === 'crawl.summary');
  assert.equal(summaries.length, Math.floor(result.events.length / 2) + 1);
  const broken = createFixtureApplication({ events: createCrawlLog({ write: () => { throw new Error('disk full'); } }) });
  assert.equal((await broken.runWorkerOnce()).jobs.every((job) => job.state === 'parsed'), true);
});

test('parsers, discovery and domain normalization gain no logging dependency', () => {
  for (const directory of ['src/parsers', 'src/discovery', 'src/domain', 'src/contracts']) {
    for (const file of readdirSync(directory).filter((name) => name.endsWith('.mjs'))) {
      const source = readFileSync(join(directory, file), 'utf8');
      assert.doesNotMatch(source, /crawl-log|\bconsole\.|process\.(stdout|stderr)|\.emit\(/, `${directory}/${file}`);
      assert.doesNotMatch(source, /from\s+['"]\.\.\/application\//, `${directory}/${file}`);
    }
  }
});

function status({ jobs, fetches }) {
  return { observedAt: '2026-01-03T00:00:00.000Z', jobs, fetches: { windowMs: 3_600_000, ...fetches } };
}

test('status reports progress by page type, request pace and a projected lower bound', () => {
  const summary = summarizeCrawlStatus(status({
    jobs: [
      { pageType: 'box_score', state: 'pending', count: 300 }, { pageType: 'box_score', state: 'parsed', count: 100 },
      { pageType: 'school_index', state: 'parsed', count: 1 }, { pageType: 'box_score', state: 'operator_stop', count: 2 },
      { pageType: 'season', state: 'parse_failed', count: 1 }, { pageType: 'season', state: 'retry_wait', count: 9 },
    ],
    fetches: { total: 500, inWindow: 300, firstAt: '2026-01-01T00:00:00.000Z', lastAt: '2026-01-02T23:59:50.000Z' },
  }));
  assert.deepEqual(summary.pageTypes.map((entry) => entry.pageType), ['school_index', 'season', 'box_score']);
  assert.deepEqual({ ...summary.totals }, { total: 413, done: 101, failed: 1, blocked: 2, remaining: 309 });
  assert.equal(summary.pace.observedPerHour, 300);
  assert.equal(summary.pace.basis, 'observed');
  assert.equal(summary.projection.remainingMs, Math.round((309 / 300) * 3_600_000));
  const text = formatCrawlStatus(summary);
  assert.match(text, /box_score\s+402\s+100\s+0\s+2\s+300\s+24\.9%/);
  assert.match(text, /300\/h observed \(policy ceiling 600\/h\)/);
  assert.match(text, /at least 1h 2m for 309 known jobs/);
});

test('status falls back to the policy pace and measures a young crawl over its own age', () => {
  const idle = summarizeCrawlStatus(status({ jobs: [{ pageType: 'season', state: 'pending', count: 600 }],
    fetches: { total: 0, inWindow: 0, firstAt: null, lastAt: null } }));
  assert.equal(idle.pace.basis, 'policy');
  assert.equal(idle.projection.remainingMs, 3_600_000);
  const young = summarizeCrawlStatus(status({ jobs: [{ pageType: 'season', state: 'pending', count: 10 }],
    fetches: { total: 50, inWindow: 50, firstAt: '2026-01-02T23:50:00.000Z', lastAt: '2026-01-02T23:59:00.000Z' } }));
  assert.equal(young.pace.observedPerHour, 300);
  const burst = summarizeCrawlStatus(status({ jobs: [{ pageType: 'season', state: 'pending', count: 600 }],
    fetches: { total: 5, inWindow: 5, firstAt: '2026-01-02T23:59:59.000Z', lastAt: '2026-01-02T23:59:59.500Z' } }));
  assert.equal(burst.projection.remainingMs, 3_600_000, 'the projection never assumes a pace above the policy ceiling');
});

test('the status command reads the configured store once and closes it', async () => {
  const output = [];
  const local = await runCli({ mode: 'status', env: {}, args: ['--json'], stdout: (line) => output.push(line) });
  assert.equal(local.exitCode, EXIT_CODES.success);
  assert.equal(JSON.parse(output[0]).totals.done, 7);

  let closed = 0;
  const persistence = {
    async crawlStatus({ windowMs }) {
      return { observedAt: '2026-01-03T00:00:00.000Z', jobs: [{ pageType: 'season', state: 'parsed', count: 4 }],
        fetches: { total: 4, inWindow: 4, windowMs, firstAt: '2026-01-02T23:30:00.000Z', lastAt: '2026-01-02T23:59:00.000Z' } };
    },
    async close() { closed += 1; },
  };
  const text = [];
  const durable = await runCli({ mode: 'status', args: [], stdout: (line) => text.push(line), openPostgres: async () => persistence,
    env: { PERSISTENCE: 'postgres', PGHOST: 'db.internal', PGDATABASE: 'scraper', PGUSER: 'scraper', PGPASSWORD: 'TOP_SECRET' } });
  assert.equal(durable.exitCode, EXIT_CODES.success);
  assert.equal(closed, 1);
  assert.match(text[0], /season\s+4\s+4/);
  assert.doesNotMatch(text[0], /TOP_SECRET|db\.internal/);
});
