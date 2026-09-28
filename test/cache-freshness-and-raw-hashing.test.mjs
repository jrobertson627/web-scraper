import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNormalizedPage } from '../src/contracts/boundaries.mjs';
import { createSourceUrl, canonicalizeSourceUrl } from '../src/contracts/source.mjs';
import { Fetcher, FixtureTransport } from '../src/fetcher/index.mjs';
import { FixtureParser, ParserRegistry } from '../src/parsers/index.mjs';
import { FileRawStore, InMemoryPersistence, MemoryRawStore } from '../src/persistence/index.mjs';
import { IngestionOrchestrator } from '../src/application/orchestrator.mjs';
import { seasonDocument } from '../src/application/fixture-documents.mjs';

const policy = { minIntervalMs: 6000, maxRequestsPerMinute: 10, hostConcurrency: 1, userAgent: 'scraper (+ops@example.com)' };
const T0 = '2026-01-01T00:00:00.000Z';
const BODY = Buffer.from(JSON.stringify(seasonDocument({ school: 'Fixture A', endingYear: 2026, gameLogUrl: null, games: [] })));

function setup({ rawStore = new MemoryRawStore(), transport, cacheMaxAgeMs = 10_000 } = {}) {
  const source = createSourceUrl('provider', 'https://allowed.example/page');
  let time = Date.parse(T0);
  const clock = () => new Date(time);
  const persistence = new InMemoryPersistence(clock);
  persistence.addJob({ key: 'job', pageType: 'season', sourceUrl: source, canonicalPath: canonicalizeSourceUrl(source) });
  const fixtureTransport = transport ?? new FixtureTransport(new Map([[source.absoluteUrl, { body: BODY.toString(), etag: 'stable' }]]));
  const fetcher = new Fetcher({ transport: fixtureTransport, rawStore, persistence, clock, sleep: async (ms) => { time += ms; },
    allowedHosts: ['allowed.example'], policy: { ...policy, cacheMaxAgeMs } });
  return { persistence, rawStore, fetcher, transport: fixtureTransport, clock, advance: (ms) => { time += ms; } };
}

// Counts sha256 computations over exactly the page body, by wrapping
// crypto.createHash for the modules' named imports.
function countBodyHashes(body) {
  const original = crypto.createHash;
  let count = 0;
  crypto.createHash = (...args) => {
    const hash = original(...args);
    const update = hash.update.bind(hash);
    hash.update = (data, ...rest) => {
      if (Buffer.from(data).equals(body)) count += 1;
      return update(data, ...rest);
    };
    return hash;
  };
  syncBuiltinESMExports();
  return {
    get count() { return count; },
    restore() { crypto.createHash = original; syncBuiltinESMExports(); },
  };
}

// Returns a fixed body without hashing it (FixtureTransport hashes for its etag).
function plainTransport(responses) {
  const requests = [];
  return {
    requests,
    async request(request) {
      requests.push(request);
      return responses.shift() ?? { status: 200, headers: {}, body: Buffer.from(BODY) };
    },
  };
}

async function withRawRoot(callback) {
  const root = mkdtempSync(join(tmpdir(), 'web-scraper-hash-'));
  try { return await callback(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

test('a cached body is revalidated once cacheMaxAgeMs has passed since its real fetch, however many hits came between', async () => {
  const run = setup();
  const job = run.persistence.claimNextJob(run.clock(), 'worker');
  assert.equal((await run.fetcher.fetch(job, job.lease)).kind, 'fetched');
  for (const _hit of [1, 2]) {
    run.advance(4_000);
    assert.equal((await run.fetcher.fetch(job, job.lease)).kind, 'not_modified');
  }
  assert.equal(run.transport.calls.length, 1);
  // Each hit keeps the fetch time of the body it reuses.
  assert.deepEqual(run.persistence.sourceFetches.map(({ cacheHit, fetchedAt }) => [cacheHit, fetchedAt]),
    [[false, T0], [true, T0], [true, T0]]);

  // 12 s after the real fetch but only 4 s after the last hit: stale, so a conditional request goes out.
  run.advance(4_000);
  assert.equal((await run.fetcher.fetch(job, job.lease)).kind, 'not_modified');
  assert.equal(run.transport.calls.length, 2);
  assert.equal(run.transport.requests[1].headers['if-none-match'], 'stable');
  const revalidated = run.persistence.lastSuccessfulFetch(job.key);
  assert.equal(revalidated.status, 304);
  assert.equal(revalidated.fetchedAt, '2026-01-01T00:00:12.000Z');

  // The 304 restarts the freshness window.
  run.advance(4_000);
  assert.equal((await run.fetcher.fetch(job, job.lease)).kind, 'not_modified');
  assert.equal(run.transport.calls.length, 2);
});

test('a fresh fetch hashes its body once, from transport through parse and commit', () => withRawRoot(async (root) => {
  const rawStore = new FileRawStore(root);
  const run = setup({ rawStore, transport: plainTransport([]) });
  const parsers = new ParserRegistry().register(new FixtureParser('season'));
  const orchestrator = new IngestionOrchestrator({
    fetcher: run.fetcher, parsers, persistence: run.persistence, rawStore, clock: run.clock,
    discovery: { discover: () => ({ observations: [], childJobs: [], unavailableCoverage: [], warnings: [] }) },
    normalizer: { normalize: (pageType, document, context) => createNormalizedPage({ jobKey: context.jobKey, kind: pageType, identity: context.jobKey, data: document }) },
  });
  const hashes = countBodyHashes(BODY);
  try {
    await orchestrator.runOnce('worker');
  } finally { hashes.restore(); }
  assert.equal(run.persistence.getJob('job').state, 'parsed');
  assert.equal(hashes.count, 1);
  assert.equal((await rawStore.entries()).length, 1);
}));

test('a cache hit and a 304 each hash the reused body once and hand it to the orchestrator', () => withRawRoot(async (root) => {
  const rawStore = new FileRawStore(root);
  const transport = plainTransport([
    { status: 200, headers: { etag: '"v1"' }, body: Buffer.from(BODY) },
    { status: 304, headers: { etag: '"v1"' } },
  ]);
  const run = setup({ rawStore, transport });
  const job = run.persistence.claimNextJob(run.clock(), 'worker');
  await run.fetcher.fetch(job, job.lease);
  for (const [advanceMs, expectedCacheHit, expectedStatus] of [[1_000, true, 200], [20_000, false, 304]]) {
    run.advance(advanceMs);
    const hashes = countBodyHashes(BODY);
    let result;
    try { result = await run.fetcher.fetch(job, job.lease); } finally { hashes.restore(); }
    assert.equal(result.kind, 'not_modified');
    assert.equal(hashes.count, 1, `status ${expectedStatus}`);
    assert.deepEqual(result.body, BODY);
    const recorded = run.persistence.lastSuccessfulFetch(job.key);
    assert.equal(recorded.cacheHit, expectedCacheHit);
    assert.equal(recorded.status, expectedStatus);
  }
  assert.equal(transport.requests.length, 2);
}));

test('the orchestrator parses the body the fetcher verified without reading the raw store again', async () => {
  const persistence = new InMemoryPersistence(() => new Date(T0));
  const source = createSourceUrl('provider', 'https://allowed.example/page');
  persistence.addJob({ key: 'job', pageType: 'season', sourceUrl: source, canonicalPath: canonicalizeSourceUrl(source) });
  const refuse = () => { throw new Error('the raw store must not be read again'); };
  const orchestrator = new IngestionOrchestrator({
    fetcher: { fetch: async () => ({ kind: 'fetched', sourceFetchId: 'fetch-1', checksum: 'a'.repeat(64), body: Buffer.from(BODY) }) },
    parsers: new ParserRegistry().register(new FixtureParser('season')),
    persistence, rawStore: { read: refuse, get: refuse, verify: refuse }, clock: () => new Date(T0),
    discovery: { discover: () => ({ observations: [], childJobs: [], unavailableCoverage: [], warnings: [] }) },
    normalizer: { normalize: (pageType, document, context) => createNormalizedPage({ jobKey: context.jobKey, kind: pageType, identity: context.jobKey, data: document }) },
  });
  await orchestrator.runOnce('worker');
  assert.equal(persistence.getJob('job').state, 'parsed');
  assert.deepEqual(persistence.pages.get('job').data, JSON.parse(BODY));
});
