import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertRealTime, createFixtureApplication, createWorkerApplication, realSleep, systemClock,
} from '../src/application/composition-root.mjs';
import { SportsReferenceSourceAdapter } from '../src/application/sports-reference-source-adapter.mjs';
import { FixtureSourceAdapter } from '../src/application/fixture-source-adapter.mjs';
import { createParseResult } from '../src/contracts/boundaries.mjs';
import { PAGE_TYPES } from '../src/contracts/source.mjs';
import { FixtureTransport } from '../src/fetcher/index.mjs';
import { HttpTransport } from '../src/fetcher/http-transport.mjs';
import { FixtureParser, ParserRegistry, createProductionParserRegistry, missingProductionParsers } from '../src/parsers/index.mjs';
import { FileRawStore, InMemoryPersistence, MemoryRawStore } from '../src/persistence/index.mjs';
import { PostgresPersistence } from '../src/persistence/postgres.mjs';

// The production worker assembly (#36) only accepts real parts. None of these
// tests opens a connection: the transport is never called and the Postgres pool
// is a stub that is never queried.

const record = (name) => JSON.parse(readFileSync(new URL(`../config/personal-use.${name}.json`, import.meta.url), 'utf8'));
const authorization = record('authorization');
const dataContract = record('data-contract');
const rawStoreRoot = mkdtempSync(join(tmpdir(), 'worker-assembly-'));

function workerConfig(overrides = {}) {
  return {
    mode: 'worker', providerId: 'sports-reference', allowedHosts: ['www.sports-reference.com'],
    rawStore: 'filesystem', rawStoreRoot, publication: 'private',
    policy: { minIntervalMs: 6000, maxRequestsPerMinute: 10, hostConcurrency: 1, userAgent: 'web-scraper-test (+ops@example.com)' },
    eligibilityPredicate: 'To == 2026', targetEndingYears: [2022, 2023, 2024, 2025, 2026],
    authorization, dataContract, ...overrides,
  };
}

class StubParser {
  constructor(pageType) { this.type = pageType; }
  pageType() { return this.type; }
  version() { return '1'; }
  parse() { return createParseResult({ kind: 'structural_failure', error: 'stub parser' }); }
}

function realParts(overrides = {}) {
  return {
    config: workerConfig(),
    transport: new HttpTransport({ resolve: async () => { throw new Error('tests make no network requests'); } }),
    persistence: new PostgresPersistence({ pool: { end: async () => {} } }),
    parsers: createProductionParserRegistry(PAGE_TYPES.map((pageType) => new StubParser(pageType))),
    ...overrides,
  };
}

function fakeTime() {
  let now = Date.parse('2026-01-01T00:00:00.000Z');
  return { clock: () => new Date(now), sleep: async (milliseconds) => { now += milliseconds; } };
}

test('worker assembly wires the Sports Reference adapter, real time, and the school index root job', async () => {
  const parts = realParts();
  const app = await createWorkerApplication(parts);
  assert.equal(app.config.mode, 'worker');
  assert.ok(app.sourceAdapter instanceof SportsReferenceSourceAdapter);
  assert.equal(app.clock, systemClock);
  assert.equal(app.sleep, realSleep);
  assert.equal(app.transport, parts.transport);
  assert.equal(app.persistence, parts.persistence);
  assert.ok(app.rawStore instanceof FileRawStore);
  assert.equal(app.rootJob.key, 'sports-reference:www.sports-reference.com/cbb/schools:school_index');
  assert.equal(app.rootJob.sourceUrl.absoluteUrl, 'https://www.sports-reference.com/cbb/schools/');
  assert.ok(app.orchestrator.discovery.sourceAdapter instanceof SportsReferenceSourceAdapter);
  assert.equal(app.orchestrator.fetcher.transport, parts.transport);
  assert.equal(app.orchestrator.fetcher.sleep, realSleep);
  assert.deepEqual([...app.orchestrator.fetcher.allowedHosts], ['www.sports-reference.com']);
  assert.deepEqual(app.orchestrator.normalizer.retainedFields, dataContract.retainedFields, 'only the data contract retained fields are stored');
});

test('worker assembly refuses a fake clock or sleep with the real transport', async () => {
  const fake = fakeTime();
  await assert.rejects(createWorkerApplication(realParts(fake)), /worker assembly refused: clock is \d+ms away from system time/);
  await assert.rejects(createWorkerApplication(realParts({ sleep: fake.sleep })), /worker assembly refused: sleep\(40\) returned after \d+ms/);
  const frozen = new Date();
  await assert.rejects(createWorkerApplication(realParts({ clock: () => frozen })), /clock advanced 0ms across/);
  await assert.rejects(assertRealTime({ clock: systemClock }), /requires clock\(\) and sleep\(ms\)/);
  await assertRealTime({ clock: systemClock, sleep: realSleep });
});

test('worker assembly refuses fixture and in-memory parts', async () => {
  await assert.rejects(createWorkerApplication(realParts({ transport: new FixtureTransport() })), /transport must be HttpTransport/);
  await assert.rejects(createWorkerApplication(realParts({ transport: undefined })), /transport must be HttpTransport/);
  await assert.rejects(createWorkerApplication(realParts({ persistence: new InMemoryPersistence() })), /persistence must be PostgresPersistence/);
  await assert.rejects(createWorkerApplication(realParts({ rawStore: new MemoryRawStore() })), /raw store must be the filesystem raw store/);
  await assert.rejects(createWorkerApplication(realParts({ config: workerConfig({ rawStore: 'memory' }) })), /raw store must be the filesystem raw store/);
  const fixtureParsers = new ParserRegistry();
  for (const pageType of PAGE_TYPES) fixtureParsers.register(new FixtureParser(pageType));
  await assert.rejects(createWorkerApplication(realParts({ parsers: fixtureParsers })),
    /no production parser is registered for school_index@1, school_history@1, season@1, game_log@1, box_score@1/);
  await assert.rejects(createWorkerApplication(realParts({ sourceAdapter: new FixtureSourceAdapter() })), /source adapter provider fixture-provider does not match/);
});

test('worker assembly selects the real adapter only behind the worker authorization gate', async () => {
  await assert.rejects(createWorkerApplication(realParts({ config: workerConfig({ authorization: undefined }) })), /authorization/);
  await assert.rejects(createWorkerApplication(realParts({ config: workerConfig({ authorization: { ...authorization, status: 'revoked' } }) })), /authorization is revoked/);
  await assert.rejects(createWorkerApplication(realParts({ config: workerConfig({ mode: 'local', authorization: undefined, dataContract: undefined }) })), /configuration mode is local, expected worker/);
});

test('the default registry reports only the phase 2 parsers that have not landed', async () => {
  const versions = Object.fromEntries(PAGE_TYPES.map((pageType) => [pageType, '1']));
  assert.deepEqual(missingProductionParsers(createProductionParserRegistry(), versions), ['box_score@1']);
  const { parsers: _unused, ...withoutParsers } = realParts();
  await assert.rejects(createWorkerApplication(withoutParsers), /no production parser is registered for box_score@1/);
  const partial = createProductionParserRegistry([new StubParser('school_index')]);
  assert.deepEqual(missingProductionParsers(partial, versions), ['school_history@1', 'season@1', 'game_log@1', 'box_score@1']);
});

test('the fixture application refuses the real transport', () => {
  assert.throws(() => createFixtureApplication({ sharedState: { transport: new HttpTransport() } }), /refused the real HttpTransport/);
  assert.throws(() => createFixtureApplication({ sharedState: { transport: new HttpTransport(), ...fakeTime() } }), /refused the real HttpTransport/);
});
