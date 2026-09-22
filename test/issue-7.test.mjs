import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfiguration } from '../src/config/configuration.mjs';
import { createSourceUrl, canonicalizeSourceUrl } from '../src/contracts/source.mjs';
import { Fetcher, FixtureTransport } from '../src/fetcher/index.mjs';
import { InMemoryPersistence, MemoryRawStore } from '../src/persistence/index.mjs';

const policy = { minIntervalMs: 6000, maxRequestsPerMinute: 10, hostConcurrency: 1, userAgent: 'scraper (+ops@example.com)' };
const scope = { eligibilityPredicate: 'To == 2026', targetEndingYears: [2022, 2023, 2024, 2025, 2026] };
const config = { mode: 'local', providerId: 'provider', allowedHosts: ['allowed.example'], rawStore: 'memory', publication: 'private', policy, ...scope };

function fixture({ response, policyOverrides = {}, sourceUrl: source = createSourceUrl('provider', 'https://allowed.example/page') } = {}) {
  let time = Date.parse('2026-01-01T00:00:00.000Z');
  const clock = () => new Date(time);
  const sleep = async (ms) => { time += ms; };
  const persistence = new InMemoryPersistence(clock);
  const rawStore = new MemoryRawStore();
  const job = { key: 'job', pageType: 'season', sourceUrl: source, canonicalPath: canonicalizeSourceUrl(source) };
  persistence.addJob(job);
  const claimed = persistence.claimNextJob(clock(), 'worker');
  const calls = [];
  const transport = { request: async (request) => { calls.push(request); return response ?? { status: 200, headers: {}, body: Buffer.from('{}') }; } };
  const fetcher = new Fetcher({ transport, rawStore, persistence, clock, sleep, allowedHosts: ['allowed.example'], policy: { ...policy, ...policyOverrides } });
  return { fetcher, job: claimed, calls, persistence, rawStore, clock, advance: (ms) => { time += ms; } };
}

test('configuration rejects unsafe request, parser, claim, and scope settings', () => {
  for (const [change, field] of [
    [{ policy: { ...policy, minIntervalMs: 5999 } }, 'minIntervalMs'],
    [{ policy: { ...policy, maxRequestsPerMinute: 11 } }, 'maxRequestsPerMinute'],
    [{ policy: { ...policy, hostConcurrency: 2 } }, 'hostConcurrency'],
    [{ policy: { ...policy, requestTimeoutMs: 0 } }, 'requestTimeoutMs'],
    [{ policy: { ...policy, maxAttempts: 0 } }, 'maxAttempts'],
    [{ policy: { ...policy, retryMaxMs: 500, retryBaseMs: 1000 } }, 'retryMaxMs'],
    [{ policy: { ...policy, maxRedirects: -1 } }, 'maxRedirects'],
    [{ requestMethod: 'POST' }, 'requestMethod'],
    [{ redirectMode: 'follow' }, 'redirectMode'],
    [{ allowedSchemes: ['http', 'https'] }, 'allowedSchemes'],
    [{ claimTimeoutMs: 100 }, 'claimTimeoutMs'],
    [{ parserVersions: { season: '1' } }, 'parserVersions'],
    [{ eligibilityPredicate: 'To >= 2026' }, 'eligibilityPredicate'],
    [{ targetEndingYears: [2022, 2023, 2024, 2025] }, 'targetEndingYears'],
  ]) assert.throws(() => validateConfiguration({ ...config, ...change }), new RegExp(field));
  const valid = validateConfiguration(config);
  assert.equal(Object.isFrozen(valid.policy), true);
  assert.equal(valid.policy.requestTimeoutMs, 30_000);
  assert.equal(valid.claimTimeoutMs, 30_000);
  assert.equal(valid.parserVersions.box_score, '1');
});

test('fetcher rejects unsafe direct policy and uses parsed URL host for ownership', async () => {
  assert.throws(() => fixture({ policyOverrides: { minIntervalMs: 1 } }), /minIntervalMs/);
  const source = { ...createSourceUrl('provider', 'https://allowed.example/page'), host: 'spoofed.example' };
  const run = fixture({ sourceUrl: source });
  assert.equal((await run.fetcher.fetch(run.job, run.job.lease)).kind, 'fetched');
  assert.equal(run.persistence.requestHistory[0].host, 'allowed.example');
  assert.equal(run.calls[0].timeoutMs, 30_000);
  assert.equal(run.calls[0].method, 'GET');
  assert.equal(run.calls[0].redirect, 'manual');
});

test('fresh verified cache avoids transport; stale cache sends conditional GET and reuses 304 body', async () => {
  const source = createSourceUrl('provider', 'https://allowed.example/page');
  const transport = new FixtureTransport(new Map([[source.absoluteUrl, { body: '{}', etag: 'stable' }]]));
  let time = Date.parse('2026-01-01T00:00:00.000Z');
  const clock = () => new Date(time);
  const persistence = new InMemoryPersistence(clock);
  const rawStore = new MemoryRawStore();
  persistence.addJob({ key: 'job', pageType: 'season', sourceUrl: source, canonicalPath: canonicalizeSourceUrl(source) });
  const job = persistence.claimNextJob(clock(), 'worker');
  const fetcher = new Fetcher({ transport, rawStore, persistence, clock, sleep: async (ms) => { time += ms; }, allowedHosts: ['allowed.example'], policy: { ...policy, cacheMaxAgeMs: 10_000 } });
  assert.equal((await fetcher.fetch(job, job.lease)).kind, 'fetched');
  const checksum = persistence.lastSuccessfulFetch(job.key).checksum;
  assert.equal((await fetcher.fetch(job, job.lease)).kind, 'not_modified');
  assert.equal(transport.calls.length, 1);
  assert.equal(persistence.lastSuccessfulFetch(job.key).cacheHit, true);
  time += 11_000;
  assert.equal((await fetcher.fetch(job, job.lease)).kind, 'not_modified');
  assert.equal(transport.calls.length, 2);
  assert.equal(transport.requests[1].headers['if-none-match'], 'stable');
  assert.equal(persistence.lastSuccessfulFetch(job.key).checksum, checksum);
  assert.equal(rawStore.entries().length, 1);
});

test('429, challenge, 5xx and redirects have bounded deterministic outcomes', async () => {
  const limited = fixture({ response: { status: 429, headers: { 'retry-after': '0' } } });
  const delay = await limited.fetcher.fetch(limited.job, limited.job.lease);
  assert.equal(delay.kind, 'retry_wait');
  assert.equal(Date.parse(delay.nextAllowedAt) - limited.clock().getTime(), 6000);
  const noHeader = fixture({ response: { status: 429, headers: {} } });
  assert.equal((await noHeader.fetcher.fetch(noHeader.job, noHeader.job.lease)).kind, 'operator_stop');
  const invalidHeader = fixture({ response: { status: 429, headers: { 'retry-after': 'not-a-date' } } });
  assert.equal((await invalidHeader.fetcher.fetch(invalidHeader.job, invalidHeader.job.lease)).kind, 'operator_stop');
  const challenge = fixture({ response: { status: 403, headers: {} } });
  assert.equal((await challenge.fetcher.fetch(challenge.job, challenge.job.lease)).kind, 'operator_stop');
  const failure = fixture({ response: { status: 503, headers: {} }, policyOverrides: { maxAttempts: 1 } });
  assert.equal((await failure.fetcher.fetch(failure.job, failure.job.lease)).kind, 'permanently_failed');
  const redirect = fixture({ response: { status: 302, redirectUrl: 'https://blocked.example/secret' } });
  assert.equal((await redirect.fetcher.fetch(redirect.job, redirect.job.lease)).kind, 'operator_stop');
  assert.equal(redirect.calls.length, 1);
  const noRedirects = fixture({ response: { status: 302, redirectUrl: 'https://allowed.example/next' }, policyOverrides: { maxRedirects: 0 } });
  assert.equal((await noRedirects.fetcher.fetch(noRedirects.job, noRedirects.job.lease)).kind, 'operator_stop');
  assert.equal(noRedirects.calls.length, 1);
});

test('5xx retries use bounded exponential backoff and stop at the attempt limit', async () => {
  const run = fixture({ response: { status: 503, headers: {} }, policyOverrides: { maxAttempts: 3, retryBaseMs: 2_000, retryMaxMs: 3_000 } });
  const first = await run.fetcher.fetch(run.job, run.job.lease);
  assert.equal(first.kind, 'retry_wait');
  assert.equal(Date.parse(first.nextAllowedAt) - run.clock().getTime(), 2_000);
  run.persistence.transitionJob(run.job.key, 'retry_wait', run.job.lease, { nextAllowedAt: first.nextAllowedAt });
  run.advance(2_000);
  const secondJob = run.persistence.claimNextJob(run.clock(), 'worker');
  const second = await run.fetcher.fetch(secondJob, secondJob.lease);
  assert.equal(second.kind, 'retry_wait');
  assert.equal(Date.parse(second.nextAllowedAt) - run.clock().getTime(), 3_000);
  run.persistence.transitionJob(secondJob.key, 'retry_wait', secondJob.lease, { nextAllowedAt: second.nextAllowedAt });
  run.advance(3_000);
  const thirdJob = run.persistence.claimNextJob(run.clock(), 'worker');
  assert.equal((await run.fetcher.fetch(thirdJob, thirdJob.lease)).kind, 'permanently_failed');
});
