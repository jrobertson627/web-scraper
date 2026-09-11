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

test('fixture worker follows eligible links, preserves projections, and records both game-log observations', async () => {
  const app = createFixtureApplication();
  const result = await app.runWorkerOnce();
  const models = app.persistence.queryModels();

  assert.equal(result.transportCalls, 7);
  assert.equal(result.jobs.filter((job) => job.pageType === 'school_history').length, 1);
  assert.equal(result.jobs.filter((job) => job.pageType === 'box_score').length, 1);
  assert.equal(result.jobs.every((job) => job.state === 'parsed'), true);
  assert.equal(models.schools.length, 2);
  assert.equal(models.schools.some((school) => school.name === 'Fixture B'), true);
  assert.equal(models.seasons.length, 2);
  assert.equal(models.games.length, 1);
  assert.equal(app.persistence.unavailableCoverage.size, 3);
  assert.equal(app.persistence.observations.size, 3);
  assert.equal(models.health.conflicts, 0);
});

test('configuration requires the complete safe request policy', () => {
  assert.throws(() => validateConfiguration({ mode: 'local', providerId: 'p', allowedHosts: ['p.example'], rawStore: 'memory', policy: { hostConcurrency: 1, userAgent: 'x (+o@e.com)' }, ...validScope }), /minIntervalMs/);
  assert.throws(() => validateConfiguration({ mode: 'local', providerId: 'p', allowedHosts: ['p.example'], rawStore: 'memory', policy: { ...validPolicy, maxRequestsPerMinute: 11 }, ...validScope }), /maxRequestsPerMinute/);
  assert.throws(() => validateConfiguration({ mode: 'local', providerId: 'p', allowedHosts: ['https://p.example'], rawStore: 'memory', policy: validPolicy, ...validScope }), /allowedHosts/);
  assert.throws(() => validateConfiguration({ mode: 'worker', providerId: 'p', allowedHosts: ['p.example'], rawStore: 'memory', policy: validPolicy, ...validScope }), /authorization/);
});

test('discovery resolves relative links and quarantines invalid links without throwing', () => {
  const discovery = new Discovery({ providerId: 'p', allowedHosts: ['allowed.example'], targetEndingYears: validScope.targetEndingYears });
  const sourceUrl = createSourceUrl('p', 'https://allowed.example/season/2026.html');
  const result = discovery.discover('season', {
    jobKey: 'parent',
    sourceUrl,
    body: Buffer.from(JSON.stringify({ gameLogUrl: './games.html' })),
    sourceUrlFrom: (url, base) => createSourceUrl('p', url, base),
  });
  assert.equal(result.childJobs[0].sourceUrl.absoluteUrl, 'https://allowed.example/season/games.html');

  const rejected = discovery.discover('season', {
    jobKey: 'parent',
    sourceUrl,
    body: Buffer.from(JSON.stringify({ gameLogUrl: 'http://allowed.example/games.html' })),
    sourceUrlFrom: (url, base) => createSourceUrl('p', url, base),
  });
  assert.equal(rejected.childJobs.length, 0);
  assert.equal(rejected.observations[0].kind, 'rejected_url');
});

test('canonical job identity is provider and page scoped', () => {
  const first = canonicalizeSourceUrl(createSourceUrl('a', 'https://example.test/path/?b=2&a=1'));
  const second = canonicalizeSourceUrl(createSourceUrl('b', 'https://example.test/path?a=1&b=2'));
  assert.notEqual(sourceKey(first, 'season'), sourceKey(second, 'season'));
  assert.equal(first.path, '/path');
  assert.equal(first.normalizedQuery, 'a=1&b=2');
});

test('retry and operator-stop states release claims for later work', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');
  const persistence = new InMemoryPersistence(() => now);
  persistence.addJob(makeJob());
  const first = persistence.claimNextJob(now, 'worker-1');
  persistence.transitionJob(first.key, 'retry_wait', first.lease, { nextAllowedAt: now.toISOString() });
  const retry = persistence.claimNextJob(now, 'worker-2');
  assert.equal(retry.key, first.key);
  persistence.transitionJob(retry.key, 'operator_stop', retry.lease);
  assert.equal(persistence.getJob(retry.key).claim, null);
  persistence.recordOperatorDisposition(retry.key, { kind: 'release_permanent', operatorId: 'ops-1', reason: 'challenge reviewed' });
  assert.equal(persistence.getJob(retry.key).state, 'permanently_failed');
});

test('fetcher sends validators and reuses immutable body on 304', async () => {
  let time = Date.parse('2026-01-01T00:00:00.000Z');
  const clock = () => new Date(time);
  const sleep = async (milliseconds) => { time += milliseconds; };
  const sourceUrl = createSourceUrl('p', 'https://allowed.example/page');
  const transport = new FixtureTransport(new Map([['https://allowed.example/page', { body: '{"ok":true}', etag: 'stable' }]]));
  const rawStore = new MemoryRawStore();
  const persistence = new InMemoryPersistence(clock);
  persistence.addJob({ key: 'job', pageType: 'season', sourceUrl, canonicalPath: canonicalizeSourceUrl(sourceUrl) });
  const job = persistence.claimNextJob(clock(), 'worker');
  const fetcher = new Fetcher({ transport, rawStore, persistence, clock, sleep, allowedHosts: ['allowed.example'], policy: { ...validPolicy } });
  const first = await fetcher.fetch(job, job.lease);
  const second = await fetcher.fetch(job, job.lease);
  assert.equal(first.kind, 'fetched');
  assert.equal(second.kind, 'not_modified');
  assert.equal(transport.requests[1].headers['if-none-match'], 'stable');
  assert.equal(second.checksum, first.checksum);
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
