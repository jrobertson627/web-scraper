import test from 'node:test';
import assert from 'node:assert/strict';
import { createFixtureApplication } from '../src/application/composition-root.mjs';
import { validateConfiguration } from '../src/config/configuration.mjs';
import { createSourceUrl, canonicalizeSourceUrl, sourceKey } from '../src/contracts/source.mjs';
import { Discovery } from '../src/discovery/index.mjs';

const validPolicy = { minIntervalMs: 6000, maxRequestsPerMinute: 10, hostConcurrency: 1, userAgent: 'test (+ops@example.com)' };
const validScope = { eligibilityPredicate: 'To == 2026', targetEndingYears: [2022, 2023, 2024, 2025, 2026] };

test('fixture local mode follows eligible linked pages and deduplicates box scores', async () => {
  const app = createFixtureApplication();
  const result = await app.runWorkerOnce();
  assert.equal(result.transportCalls, 7);
  assert.equal(result.jobs.length, 7);
  assert.equal(result.jobs.filter((job) => job.pageType === 'box_score').length, 1);
  assert.equal(result.jobs.every((job) => job.state === 'parsed'), true);
  assert.equal(app.persistence.pages.size, 7);
  assert.equal(app.persistence.unavailableCoverage.length, 3);
  assert.equal(app.persistence.queryModels().games.length, 1);
});

test('worker authorization and exact scope fail before capability starts', () => {
  assert.throws(() => validateConfiguration({ mode: 'worker', providerId: 'p', allowedHosts: ['p.example'], rawStore: 'memory', policy: validPolicy, ...validScope }), /authorization/);
  assert.throws(() => validateConfiguration({ mode: 'local', providerId: 'p', allowedHosts: ['p.example'], rawStore: 'memory', policy: validPolicy, eligibilityPredicate: 'To >= 2022', targetEndingYears: validScope.targetEndingYears }), /Expected exactly To == 2026/);
  assert.throws(() => validateConfiguration({ mode: 'local', providerId: 'p', allowedHosts: ['p.example'], rawStore: 'memory', policy: validPolicy, eligibilityPredicate: validScope.eligibilityPredicate, targetEndingYears: [2022, 2023] }), /Expected exactly/);
});

test('discovery quarantines off-host links without transport access', () => {
  const discovery = new Discovery({ providerId: 'p', allowedHosts: ['allowed.example'], targetEndingYears: validScope.targetEndingYears });
  const result = discovery.discover('season', {
    jobKey: 'parent',
    body: Buffer.from(JSON.stringify({ gameLogUrl: 'https://evil.example/gamelogs' })),
    sourceUrlFrom: (url) => createSourceUrl('p', url),
  });
  assert.equal(result.childJobs.length, 0);
  assert.equal(result.observations[0].kind, 'rejected_url');
});

test('canonical job identity is provider and page scoped', () => {
  const first = canonicalizeSourceUrl(createSourceUrl('a', 'https://example.test/path/?b=2&a=1'));
  const second = canonicalizeSourceUrl(createSourceUrl('b', 'https://example.test/path?a=1&b=2'));
  assert.notEqual(sourceKey(first, 'season'), sourceKey(second, 'season'));
  assert.equal(first.path, '/path');
  assert.equal(first.normalizedQuery, 'a=1&b=2');
});

test('read-only API serves local projections without worker access', async () => {
  const app = createFixtureApplication();
  await app.runWorkerOnce();
  const server = app.createApiServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/games`);
    assert.equal(response.status, 200);
    const games = await response.json();
    assert.equal(games.length, 1);
    assert.equal(app.persistence.inFlight.size, 0);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
