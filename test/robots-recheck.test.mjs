import test from 'node:test';
import assert from 'node:assert/strict';
import { createJob } from '../src/contracts/boundaries.mjs';
import { canonicalizeSourceUrl, createSourceUrl } from '../src/contracts/source.mjs';
import { Fetcher, FixtureTransport } from '../src/fetcher/index.mjs';
import { RobotsGuard, crawlDelaySeconds } from '../src/fetcher/robots.mjs';
import { InMemoryPersistence, MemoryRawStore } from '../src/persistence/index.mjs';
import { IngestionOrchestrator } from '../src/application/orchestrator.mjs';
import { SPORTS_REFERENCE_HOST, SportsReferenceSourceAdapter } from '../src/application/sports-reference-source-adapter.mjs';

// #131: robots.txt is fetched while the crawl runs, at the start of a run and
// then daily, through the same paced transport, and the run halts when it asks
// for something the crawler does not honour.

const ORIGIN = `https://${SPORTS_REFERENCE_HOST}`;
const ROBOTS = `${ORIGIN}/robots.txt`;
const CURRENT = 'User-agent: *\nDisallow: /cbb/boxscores/index.cgi?*\nDisallow: /cbb/req/\nDisallow: /cbb/short/\nDisallow: /cbb/nocdn/\nDisallow: /cfb/req/\n';
const DAY = 24 * 60 * 60 * 1000;
const adapter = new SportsReferenceSourceAdapter();

const jobFor = (path) => {
  const sourceUrl = createSourceUrl('sports-reference', `${ORIGIN}${path}`);
  return createJob({ key: `sports-reference:${SPORTS_REFERENCE_HOST}${path}:school_history`, pageType: 'school_history', sourceUrl, canonicalPath: canonicalizeSourceUrl(sourceUrl) });
};

// A worker whose server serves robots.txt from `state.robots` (a body, or a { status, headers, body } response).
function harness({ robots = CURRENT, jobs = ['/cbb/schools/duke/men/', '/cbb/schools/unc/men/'], guard = true, intervalMs } = {}) {
  let now = Date.parse('2026-01-01T00:00:00.000Z');
  const clock = () => new Date(now);
  const persistence = new InMemoryPersistence(clock, { claimTimeoutMs: 30_000, authorizeOperator: () => true });
  const rawStore = new MemoryRawStore();
  const state = { robots };
  const calls = [];
  const transport = new FixtureTransport(new Map());
  transport.request = async ({ url }) => {
    calls.push({ url, at: now });
    if (url === ROBOTS) {
      const value = state.robots;
      if (typeof value === 'string') return { status: 200, headers: {}, body: Buffer.from(value) };
      return { status: value.status, headers: value.headers ?? {}, body: Buffer.from(value.body ?? ''), challenge: value.challenge };
    }
    return { status: 200, headers: {}, body: Buffer.from('{}') };
  };
  const events = [];
  const robotsGuard = guard ? new RobotsGuard({ evaluate: (text) => adapter.robotsProblems(text), ...(intervalMs ? { intervalMs } : {}) }) : undefined;
  const fetcher = new Fetcher({
    transport, rawStore, persistence, clock, sleep: async (ms) => { now += ms; }, allowedHosts: [SPORTS_REFERENCE_HOST], robots: robotsGuard,
    events: { emit: (name, fields) => events.push([name, fields]) },
    policy: { minIntervalMs: 6_000, maxRequestsPerMinute: 10, hostConcurrency: 1, userAgent: 'scraper (+ops@example.com)' },
  });
  for (const path of jobs) persistence.addJob(jobFor(path));
  const claim = () => persistence.claimNextJob(clock(), 'worker');
  return { persistence, fetcher, rawStore, state, calls, events, clock, claim, advance: (ms) => { now += ms; }, robotsGuard };
}
const urls = (run) => run.calls.map((call) => call.url.replace(ORIGIN, ''));

test('the longest Crawl-delay in the file is found, in any group', () => {
  assert.equal(crawlDelaySeconds('User-agent: *\nDisallow: /x/\n'), null);
  assert.equal(crawlDelaySeconds('User-agent: *\nCrawl-delay: 3\nUser-agent: bot\nCrawl-delay: 10 # slow\n'), 10);
  assert.equal(crawlDelaySeconds('crawl-delay: 2.5'), 2.5);
});

test('the guard is due until it has checked, then again after its interval', () => {
  const guard = new RobotsGuard({ evaluate: () => [] });
  const start = new Date('2026-01-01T00:00:00Z');
  assert.equal(guard.due('h', start), true);
  guard.markChecked('h', start);
  assert.equal(guard.due('h', new Date(start.getTime() + DAY - 1)), false);
  assert.equal(guard.due('h', new Date(start.getTime() + DAY)), true);
  assert.equal(guard.due('other', start), true, 'each host is tracked on its own');
  assert.throws(() => new RobotsGuard({}), /evaluate/);
  assert.throws(() => new RobotsGuard({ evaluate: () => [], intervalMs: 1000 }), /at least a minute/);
  assert.deepEqual(guard.problems('User-agent: *\nCrawl-delay: 20\n', { minIntervalMs: 6_000 }), ['sets Crawl-delay 20s, longer than the 6s request interval']);
  assert.deepEqual(guard.problems('User-agent: *\nCrawl-delay: 3\n', { minIntervalMs: 6_000 }), []);
});

test('the adapter names the Disallow rules it does not refuse', () => {
  assert.deepEqual(adapter.robotsProblems(CURRENT), []);
  assert.deepEqual(adapter.robotsProblems(`${CURRENT}Disallow: /cbb/players/\n`), ['disallows /cbb/players/, which the crawler does not refuse']);
});

test('robots.txt is fetched before the first page of a run, paced like any request, and not again until it is due', async () => {
  const run = harness();
  const first = run.claim();
  assert.equal((await run.fetcher.fetch(first, first.lease)).kind, 'fetched');
  assert.deepEqual(urls(run), ['/robots.txt', '/cbb/schools/duke/men/'], 'robots.txt first, from the same host');
  assert.ok(run.calls[1].at - run.calls[0].at >= 6_000, 'the page waited its normal interval after the robots.txt request');
  assert.deepEqual(run.events.filter(([name]) => name === 'robots.checked').map(([, fields]) => fields.problems), [[]]);

  const second = run.claim();
  assert.equal((await run.fetcher.fetch(second, second.lease)).kind, 'fetched');
  assert.deepEqual(urls(run), ['/robots.txt', '/cbb/schools/duke/men/', '/cbb/schools/unc/men/'], 'not asked for again the same day');

  run.advance(DAY);
  run.persistence.addJob(jobFor('/cbb/schools/unc/men/2026.html'.replace('.html', '/')));
  const third = run.claim();
  await run.fetcher.fetch(third, third.lease);
  assert.deepEqual(urls(run).filter((url) => url === '/robots.txt').length, 2, 'checked again after a day');
  assert.equal(run.persistence.requestHistory.length, 3, 'one host lock per job; the robots.txt request was made under the first job');
  assert.equal(run.calls.length, 5);
});

test('a robots.txt that now disallows a crawled path stops before any request to that path, and the run halts', async () => {
  const run = harness({ robots: `${CURRENT}Disallow: /cbb/schools/\n` });
  const orchestrator = new IngestionOrchestrator({ fetcher: run.fetcher, discovery: {}, parsers: {}, normalizer: {}, persistence: run.persistence, rawStore: run.rawStore, clock: run.clock });
  // The manual check treats a rule as unrefused when the adapter does not list it.
  const result = await orchestrator.runOnce('worker');
  assert.deepEqual(urls(run), ['/robots.txt'], 'nothing under /cbb/schools/ was requested');
  assert.equal(result.halt.reason, 'robots_changed');
  assert.match(result.events[0].reason, /robots\.txt now disallows \/cbb\/schools\/, which the crawler does not refuse/);
  assert.equal(run.persistence.getJob(jobFor('/cbb/schools/duke/men/').key).state, 'operator_stop');
  // A restarted worker makes no request until the stop has been reviewed.
  const restarted = await orchestrator.runOnce('worker');
  assert.deepEqual([restarted.halt.reason, restarted.processed, run.calls.length], ['robots_changed', 0, 1]);
});

test('after review the check runs again, and passes once robots.txt is back to what the crawler honours', async () => {
  const run = harness({ robots: `${CURRENT}Disallow: /cbb/players/\n`, jobs: ['/cbb/schools/duke/men/'] });
  const orchestrator = new IngestionOrchestrator({ fetcher: run.fetcher, discovery: {}, parsers: {}, normalizer: {}, persistence: run.persistence, rawStore: run.rawStore, clock: run.clock });
  assert.equal((await orchestrator.runOnce('worker')).halt.reason, 'robots_changed');
  run.persistence.recordOperatorDisposition(jobFor('/cbb/schools/duke/men/').key, { kind: 'release_retry', operatorId: 'ops', reason: 'the adapter was updated' });
  run.state.robots = CURRENT;
  run.advance(1_000);
  const resumed = await orchestrator.runOnce('worker');
  assert.equal(resumed.halt, undefined);
  assert.deepEqual(urls(run), ['/robots.txt', '/robots.txt', '/cbb/schools/duke/men/'], 'a failed check is not remembered as done');
});

test('a Crawl-delay longer than the request interval halts the run; a shorter one does not', async () => {
  const slow = harness({ robots: `${CURRENT}Crawl-delay: 10\n` });
  const job = slow.claim();
  const result = await slow.fetcher.fetch(job, job.lease);
  assert.deepEqual([result.kind, result.code], ['operator_stop', 'robots_changed']);
  assert.match(result.reason, /sets Crawl-delay 10s, longer than the 6s request interval/);
  assert.deepEqual(urls(slow), ['/robots.txt']);

  const fine = harness({ robots: `${CURRENT}Crawl-delay: 3\n` });
  const ok = fine.claim();
  assert.equal((await fine.fetcher.fetch(ok, ok.lease)).kind, 'fetched');
});

test('a missing robots.txt means no restrictions; an unreadable one stops for review', async () => {
  const missing = harness({ robots: { status: 404 } });
  const job = missing.claim();
  assert.equal((await missing.fetcher.fetch(job, job.lease)).kind, 'fetched');
  const next = missing.claim();
  await missing.fetcher.fetch(next, next.lease);
  assert.equal(urls(missing).filter((url) => url === '/robots.txt').length, 1, 'a 404 counts as checked');

  for (const body of [{ status: 200, body: '<html>Not robots</html>' }, { status: 301 }, { status: 418 }]) {
    const run = harness({ robots: body });
    const claimed = run.claim();
    const result = await run.fetcher.fetch(claimed, claimed.lease);
    assert.deepEqual([result.kind, result.code], ['operator_stop', 'robots_unavailable'], JSON.stringify(body));
    assert.deepEqual(urls(run), ['/robots.txt']);
  }
});

test('robots.txt failures are handled like the same failure on a page', async () => {
  const server = harness({ robots: { status: 503 } });
  const job = server.claim();
  const failed = await server.fetcher.fetch(job, job.lease);
  assert.deepEqual([failed.kind, failed.code, failed.charge], ['retry_wait', 'upstream_5xx', 'failure'], 'a 5xx is a retryable infrastructure failure');
  assert.deepEqual(urls(server), ['/robots.txt']);

  const blocked = harness({ robots: { status: 403 } });
  const other = blocked.claim();
  assert.deepEqual([(await blocked.fetcher.fetch(other, other.lease)).code], ['challenge']);

  const limited = harness({ robots: { status: 429, headers: { 'retry-after': '3600' } } });
  const third = limited.claim();
  const paused = await limited.fetcher.fetch(third, third.lease);
  assert.deepEqual([paused.kind, paused.charge], ['retry_wait', 'rate_limit']);
  const pausedUntil = limited.persistence.getRequestSchedule(SPORTS_REFERENCE_HOST).pausedUntil.getTime();
  assert.ok(pausedUntil >= Date.parse('2026-01-01T00:00:00.000Z') + 3_600_000 && pausedUntil <= Date.parse('2026-01-01T00:00:00.000Z') + 3_620_000, 'the host is paused until the Retry-After');
});

test('without a guard no robots.txt request is made', async () => {
  const run = harness({ guard: false });
  const job = run.claim();
  assert.equal((await run.fetcher.fetch(job, job.lease)).kind, 'fetched');
  assert.deepEqual(urls(run), ['/cbb/schools/duke/men/']);
});
