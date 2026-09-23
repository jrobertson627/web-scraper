import test from 'node:test';
import assert from 'node:assert/strict';
import { createSourceUrl, canonicalizeSourceUrl } from '../src/contracts/source.mjs';
import { Fetcher, FixtureTransport } from '../src/fetcher/index.mjs';
import { InMemoryPersistence, MemoryRawStore } from '../src/persistence/index.mjs';

const policy = { minIntervalMs: 30_000, maxRequestsPerMinute: 10, hostConcurrency: 1, userAgent: 'scraper (+ops@example.com)' };

test('waitForPolicy caps sleep chunks to a fraction of claimTimeoutMs, not a fixed 10s', async () => {
  let time = Date.parse('2026-01-01T00:00:00.000Z');
  const clock = () => new Date(time);
  const sleepCalls = [];
  const sleep = async (ms) => { sleepCalls.push(ms); time += ms; };
  const claimTimeoutMs = 10_000; // the configured minimum
  const persistence = new InMemoryPersistence(clock, { claimTimeoutMs });
  const rawStore = new MemoryRawStore();
  const sourceUrl = createSourceUrl('provider', 'https://allowed.example/page');
  persistence.addJob({ key: 'job', pageType: 'season', sourceUrl, canonicalPath: canonicalizeSourceUrl(sourceUrl) });
  const transport = new FixtureTransport(new Map([[sourceUrl.absoluteUrl, { body: '{}' }]]));
  const fetcher = new Fetcher({ transport, rawStore, persistence, clock, sleep, allowedHosts: ['allowed.example'], policy });

  const claimed = persistence.claimNextJob(clock(), 'worker');
  assert.equal((await fetcher.fetch(claimed, claimed.lease)).kind, 'fetched');

  const result = await fetcher.fetch(claimed, claimed.lease);

  assert.equal(result.kind, 'not_modified');
  assert.ok(sleepCalls.length > 0, 'the second fetch should have waited for minIntervalMs');
  for (const ms of sleepCalls) assert.ok(ms <= claimTimeoutMs / 3, `sleep chunk ${ms}ms left no renewal margin against a ${claimTimeoutMs}ms claim`);
  assert.equal(new Date(persistence.getJob(claimed.key).claim.expiresAt) > clock(), true);
});
