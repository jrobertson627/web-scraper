import test from 'node:test';
import assert from 'node:assert/strict';
import { createFixtureApplication } from '../src/application/composition-root.mjs';
import { validateConfiguration } from '../src/config/configuration.mjs';
import { createSourceUrl, canonicalizeSourceUrl, sourceKey } from '../src/contracts/source.mjs';
import { Discovery } from '../src/discovery/index.mjs';
import { FixtureParser } from '../src/parsers/index.mjs';
import { FixtureTransport, Fetcher } from '../src/fetcher/index.mjs';
import { InMemoryPersistence, MemoryRawStore } from '../src/persistence/index.mjs';

const validPolicy = { minIntervalMs: 6000, maxRequestsPerMinute: 10, hostConcurrency: 1, userAgent: 'test (+ops@example.com)' };
const validScope = { eligibilityPredicate: 'To == 2026', targetEndingYears: [2022, 2023, 2024, 2025, 2026] };

function makeJob(providerId = 'p', absoluteUrl = 'https://allowed.example/page') {
  const sourceUrl = createSourceUrl(providerId, absoluteUrl);
  return { key: `${providerId}:allowed.example/page:season`, pageType: 'season', sourceUrl, canonicalPath: canonicalizeSourceUrl(sourceUrl) };
}

function makeClock() {
  let time = Date.parse('2026-01-01T00:00:00.000Z');
  return { clock: () => new Date(time), sleep: async (milliseconds) => { time += milliseconds; }, now: () => time };
}

test('fixture worker follows eligible links, preserves projections, and records observations', async () => {
  const app = createFixtureApplication();
  const result = await app.runWorkerOnce();
  const models = app.persistence.queryModels();

  assert.equal(result.transportCalls, 7);
  assert.equal(result.jobs.filter((job) => job.pageType === 'school_history').length, 1);
  assert.equal(result.jobs.filter((job) => job.pageType === 'box_score').length, 1);
  assert.equal(result.jobs.every((job) => job.state === 'parsed'), true);
  assert.equal(models.schools.length, 2);
  assert.equal(models.schools.find((school) => school.name === 'Fixture A').eligible, true);
  assert.equal(models.schools.find((school) => school.name === 'Fixture B').eligible, false);
  assert.equal(models.seasons.length, 2);
  assert.equal(models.games.length, 1);
  assert.equal(app.persistence.unavailableCoverage.size, 3);
  assert.equal(app.persistence.observations.size, 5);
  assert.equal(models.health.conflicts, 0);
});

test('configuration requires the complete safe request policy', () => {
  assert.throws(() => validateConfiguration({ mode: 'local', providerId: 'p', allowedHosts: ['p.example'], rawStore: 'memory', policy: { hostConcurrency: 1, userAgent: 'x (+o@e.com)' }, ...validScope }), /minIntervalMs/);
  assert.throws(() => validateConfiguration({ mode: 'local', providerId: 'p', allowedHosts: ['p.example'], rawStore: 'memory', policy: { ...validPolicy, maxRequestsPerMinute: 11 }, ...validScope }), /maxRequestsPerMinute/);
  assert.throws(() => validateConfiguration({ mode: 'local', providerId: 'p', allowedHosts: ['https://p.example'], rawStore: 'memory', policy: validPolicy, ...validScope }), /allowedHosts/);
  assert.throws(() => validateConfiguration({ mode: 'worker', providerId: 'p', allowedHosts: ['p.example'], rawStore: 'memory', policy: validPolicy, ...validScope }), /authorization/);
});

test('discovery resolves relative links, preserves row identity, and quarantines invalid links', () => {
  const discovery = new Discovery({ providerId: 'p', allowedHosts: ['allowed.example'], targetEndingYears: validScope.targetEndingYears });
  const sourceUrl = createSourceUrl('p', 'https://allowed.example/season/2026.html');
  const result = discovery.discover('season', {
    jobKey: 'parent', sourceUrl, body: Buffer.from(JSON.stringify({ gameLogUrl: './games.html' })),
    sourceUrlFrom: (url, base) => createSourceUrl('p', url, base),
  });
  assert.equal(result.childJobs[0].sourceUrl.absoluteUrl, 'https://allowed.example/season/games.html');

  const rejected = discovery.discover('season', {
    jobKey: 'parent', sourceUrl, body: Buffer.from(JSON.stringify({ gameLogUrl: 'http://allowed.example/games.html' })),
    sourceUrlFrom: (url, base) => createSourceUrl('p', url, base),
  });
  assert.equal(rejected.childJobs.length, 0);
  assert.equal(rejected.observations[0].kind, 'rejected_url');

  const index = discovery.discover('school_index', {
    jobKey: 'index', sourceUrl: createSourceUrl('p', 'https://allowed.example/cbb/schools/'),
    sourceUrlFrom: (url, base) => createSourceUrl('p', url, base),
  }, { schools: [{ path: '/a', to: 2026, historyUrl: '/a/men/' }, { path: '/b', to: 2026, historyUrl: '/b/men/' }] });
  assert.deepEqual(index.observations.filter((item) => item.kind === 'school').map((item) => item.rowIndex), [0, 1]);
});

test('missing school identity is quarantined instead of becoming an undefined URL', () => {
  const discovery = new Discovery({ providerId: 'p', allowedHosts: ['allowed.example'], targetEndingYears: validScope.targetEndingYears });
  const result = discovery.discover('school_index', {
    jobKey: 'index', sourceUrl: createSourceUrl('p', 'https://allowed.example/cbb/schools/'),
    sourceUrlFrom: (url, base) => createSourceUrl('p', url, base),
  }, { schools: [{ to: 2026, historyUrl: '/a/men/' }] });
  assert.equal(result.childJobs.length, 0);
  assert.match(result.observations.at(-1).reason, /source path is missing/);
});

test('canonical job identity is provider and page scoped', () => {
  const first = canonicalizeSourceUrl(createSourceUrl('a', 'https://example.test/path/?b=2&a=1'));
  const second = canonicalizeSourceUrl(createSourceUrl('b', 'https://example.test/path?a=1&b=2'));
  assert.notEqual(sourceKey(first, 'season'), sourceKey(second, 'season'));
  assert.equal(first.path, '/path');
  assert.equal(first.normalizedQuery, 'a=1&b=2');
});

test('retry and operator-stop states release claims and validate dispositions', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');
  const persistence = new InMemoryPersistence(() => now);
  persistence.addJob(makeJob());
  const first = persistence.claimNextJob(now, 'worker-1');
  persistence.transitionJob(first.key, 'retry_wait', first.lease, { nextAllowedAt: now.toISOString() });
  const retry = persistence.claimNextJob(now, 'worker-2');
  assert.equal(retry.key, first.key);
  persistence.transitionJob(retry.key, 'operator_stop', retry.lease);
  assert.equal(persistence.getJob(retry.key).claim, null);
  assert.throws(() => persistence.recordOperatorDisposition(retry.key, { kind: 'bogus' }), /invalid operator disposition/);
  persistence.recordOperatorDisposition(retry.key, { kind: 'release_permanent', operatorId: 'ops-1', reason: 'challenge reviewed' });
  assert.equal(persistence.getJob(retry.key).state, 'permanently_failed');
});

test('expired fetched jobs return to retryable state', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');
  const persistence = new InMemoryPersistence(() => now);
  persistence.addJob(makeJob());
  const job = persistence.claimNextJob(now, 'worker');
  persistence.transitionJob(job.key, 'fetched', job.lease);
  const later = new Date(now.getTime() + 60_000);
  assert.equal(persistence.recoverExpiredClaims(later), 1);
  assert.equal(persistence.claimNextJob(later, 'worker-2').key, job.key);
});

test('link-less game-log rows remain distinct observations', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');
  const persistence = new InMemoryPersistence(() => now);
  const sourceUrl = createSourceUrl('p', 'https://allowed.example/log');
  persistence.addJob({ key: 'log', pageType: 'game_log', sourceUrl, canonicalPath: canonicalizeSourceUrl(sourceUrl) });
  const job = persistence.claimNextJob(now, 'worker');
  persistence.transitionJob(job.key, 'fetched', job.lease);
  persistence.commitPage({ jobKey: 'log', kind: 'game_log', identity: 'log', observations: [
    { kind: 'game_log', parentKey: 'log', rowIndex: 0, game: { opponent: 'A' } },
    { kind: 'game_log', parentKey: 'log', rowIndex: 1, game: { opponent: 'B' } },
  ] }, { providerId: 'p' }, job.lease);
  assert.equal(persistence.observations.size, 2);
});

test('fetcher renews claims while waiting for request rate limits and reuses 304 bodies', async () => {
  const time = makeClock();
  const sourceUrl = createSourceUrl('p', 'https://allowed.example/page');
  const transport = new FixtureTransport(new Map([['https://allowed.example/page', { body: '{"ok":true}', etag: 'stable' }]]));
  const rawStore = new MemoryRawStore();
  const persistence = new InMemoryPersistence(time.clock);
  persistence.addJob({ key: 'job', pageType: 'season', sourceUrl, canonicalPath: canonicalizeSourceUrl(sourceUrl) });
  const job = persistence.claimNextJob(time.clock(), 'worker');
  const fetcher = new Fetcher({ transport, rawStore, persistence, clock: time.clock, sleep: time.sleep, allowedHosts: ['allowed.example'], policy: { ...validPolicy, maxRequestsPerMinute: 1 } });
  const first = await fetcher.fetch(job, job.lease);
  const second = await fetcher.fetch(job, job.lease);
  assert.equal(first.kind, 'fetched');
  assert.equal(second.kind, 'not_modified');
  assert.equal(transport.requests[1].headers['if-none-match'], 'stable');
  assert.equal(second.checksum, first.checksum);
  assert.equal(new Date(persistence.getJob(job.key).claim.expiresAt) > time.clock(), true);
});

test('malformed parser input becomes a structural failure', () => {
  const result = new FixtureParser('season').parse({ body: Buffer.from('<not-json>') });
  assert.equal(result.kind, 'structural_failure');
  assert.match(result.error, /could not be parsed/);
});

test('read-only API handles query strings, trailing slashes, and mutation rejection', async () => {
  const app = createFixtureApplication();
  await app.runWorkerOnce();
  const server = app.createApiServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/games/?page=1`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).length, 1);
    const mutation = await fetch(`http://127.0.0.1:${port}/games`, { method: 'POST' });
    assert.equal(mutation.status, 405);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
