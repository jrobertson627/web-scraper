import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSourceUrl, canonicalizeSourceUrl } from '../src/contracts/source.mjs';
import { Fetcher, FixtureTransport } from '../src/fetcher/index.mjs';
import { FileRawStore, InMemoryPersistence, createRawStore } from '../src/persistence/index.mjs';
import { validateConfiguration } from '../src/config/configuration.mjs';
import { IngestionOrchestrator } from '../src/application/orchestrator.mjs';

const policy = { minIntervalMs: 6000, maxRequestsPerMinute: 10, hostConcurrency: 1, userAgent: 'scraper (+ops@example.com)' };
const scope = { eligibilityPredicate: 'To == 2026', targetEndingYears: [2022, 2023, 2024, 2025, 2026] };

async function withRawDirectory(callback) {
  const root = mkdtempSync(join(tmpdir(), 'web-scraper-m3-'));
  try { return await callback(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

function objectFile(root, checksum) { return join(root, checksum.slice(0, 2), checksum); }
function sha256(body) { return createHash('sha256').update(body).digest('hex'); }

test('filesystem raw port preserves immutable bytes and verifies real files', () => withRawDirectory(async (root) => {
  const store = createRawStore('filesystem', root);
  const first = await store.put(Buffer.from('immutable body'));
  const second = await store.put(Buffer.from('immutable body'));
  assert.deepEqual(first, second);
  assert.equal(first.ok, true);
  assert.deepEqual(await store.entries(), [{ checksum: first.checksum, objectPath: first.objectPath, size: 14 }]);
  const read = await store.get(first.checksum);
  read.body[0] = 0;
  assert.equal((await store.get(first.checksum)).body.toString(), 'immutable body');
  assert.equal((await store.read(first.checksum, first.objectPath)).body.toString(), 'immutable body');
  assert.deepEqual(await store.verify(first.checksum, first.objectPath), { ok: true, checksum: first.checksum, objectPath: first.objectPath, size: 14 });
  assert.equal((await store.verify(first.checksum, 'file://wrong')).reason, 'raw object path mismatch');
  assert.equal((await store.verify('../escape')).reason, 'invalid raw checksum');
  assert.equal(await store.get('../escape'), null);
  assert.equal((await store.temporaryEntries()).length, 0);
  assert.equal(readFileSync(objectFile(root, first.checksum)).toString(), 'immutable body');
}));

test('filesystem root must be explicit and absolute', () => {
  assert.throws(() => createRawStore('filesystem'), /absolute root/);
  assert.throws(() => new FileRawStore('.raw'), /absolute root/);
  assert.throws(() => validateConfiguration({ mode: 'local', providerId: 'p', allowedHosts: ['allowed.example'], rawStore: 'filesystem', policy, publication: 'private', ...scope }), /rawStoreRoot/);
});

test('interruption before finalization leaves only an unparseable temporary object', () => withRawDirectory(async (root) => {
  const moduleUrl = pathToFileURL(fileURLToPath(new URL('../src/persistence/index.mjs', import.meta.url))).href;
  const child = `
    import fs from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    fs.link = async () => process.exit(73);
    syncBuiltinESMExports();
    const { FileRawStore } = await import(process.env.RAW_TEST_MODULE);
    await new FileRawStore(process.env.RAW_TEST_ROOT).put(Buffer.from('interrupted body'));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', child], {
    encoding: 'utf8',
    env: { ...process.env, RAW_TEST_MODULE: moduleUrl, RAW_TEST_ROOT: root },
  });
  assert.equal(result.status, 73, result.stderr);
  const store = new FileRawStore(root);
  const checksum = sha256('interrupted body');
  assert.equal(await store.get(checksum), null);
  assert.equal((await store.verify(checksum)).reason, 'missing raw object');
  assert.deepEqual(await store.entries(), []);
  assert.equal((await store.temporaryEntries()).length, 1);
  const report = await new InMemoryPersistence().repairRawObjects({ rawStore: store });
  assert.equal(report.counts.temporary, 1);
  assert.equal(report.counts.orphans, 0);
  assert.equal((await store.put(Buffer.from('interrupted body'))).checksum, checksum);
  assert.equal((await store.verify(checksum)).ok, true);
}));

test('filesystem-backed conditional 304 reuses one body and records two verified fetches', async () => {
  const root = mkdtempSync(join(tmpdir(), 'web-scraper-m3-'));
  try {
    const source = createSourceUrl('provider', 'https://allowed.example/page');
    const transport = new FixtureTransport(new Map([[source.absoluteUrl, { body: 'cached body', etag: 'stable' }]]));
    let time = Date.parse('2026-01-01T00:00:00.000Z');
    const clock = () => new Date(time);
    const persistence = new InMemoryPersistence(clock);
    const rawStore = new FileRawStore(root);
    persistence.addJob({ key: 'job', pageType: 'season', sourceUrl: source, canonicalPath: canonicalizeSourceUrl(source) });
    const job = persistence.claimNextJob(clock(), 'worker');
    const fetcher = new Fetcher({ transport, rawStore, persistence, clock, sleep: async (ms) => { time += ms; }, allowedHosts: ['allowed.example'], policy });
    const first = await fetcher.fetch(job, job.lease);
    const second = await fetcher.fetch(job, job.lease);
    assert.equal(first.kind, 'fetched');
    assert.equal(second.kind, 'not_modified');
    assert.equal(second.checksum, first.checksum);
    assert.deepEqual(persistence.sourceFetches.map((fetch) => fetch.status), [200, 304]);
    assert.equal(persistence.sourceFetches[1].objectPath, persistence.sourceFetches[0].objectPath);
    assert.equal(transport.calls.length, 2);
    assert.equal((await rawStore.entries()).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('repair classifies real missing, mismatched, and orphaned files without changing fetch records', async () => {
  const root = mkdtempSync(join(tmpdir(), 'web-scraper-m3-'));
  try {
    const store = new FileRawStore(root);
    const healthy = await store.put(Buffer.from('healthy'));
    const orphan = await store.put(Buffer.from('orphan'));
    const damaged = await store.put(Buffer.from('damaged'));
    const missingChecksum = sha256('missing');
    writeFileSync(objectFile(root, damaged.checksum), Buffer.from('tampered bytes'));
    const persistence = new InMemoryPersistence(() => new Date('2026-01-01T00:00:00.000Z'));
    persistence.sourceFetches.push(
      { id: 'fetch-healthy', checksum: healthy.checksum, objectPath: healthy.objectPath },
      { id: 'fetch-healthy-304', checksum: healthy.checksum, objectPath: healthy.objectPath },
      { id: 'fetch-missing', checksum: missingChecksum, objectPath: `file://${objectFile(root, missingChecksum)}` },
      { id: 'fetch-damaged', checksum: damaged.checksum, objectPath: damaged.objectPath },
    );
    const before = structuredClone(persistence.sourceFetches);
    const report = await persistence.repairRawObjects({ rawStore: store });
    assert.deepEqual(report.counts, { healthy: 1, pending: 2, orphans: 1, temporary: 0 });
    assert.deepEqual(report.pending.map(({ defect }) => defect).sort(), ['checksum_mismatch', 'missing']);
    assert.deepEqual(report.pending.flatMap(({ sourceFetchIds }) => sourceFetchIds).sort(), ['fetch-damaged', 'fetch-missing']);
    assert.equal(report.orphans[0].checksum, orphan.checksum);
    assert.deepEqual(report.healthy[0].sourceFetchIds, ['fetch-healthy', 'fetch-healthy-304']);
    assert.equal((await store.verify(damaged.checksum)).ok, false);
    assert.equal(await store.get(damaged.checksum), null);
    assert.deepEqual(persistence.sourceFetches, before);
    assert.equal((await store.entries()).length, 3);

    const source = createSourceUrl('provider', 'https://allowed.example/page');
    persistence.addJob({ key: 'job', pageType: 'season', sourceUrl: source, canonicalPath: canonicalizeSourceUrl(source) });
    const job = persistence.claimNextJob(new Date('2026-01-01T00:00:00.000Z'), 'worker');
    const damagedRead = await store.read(damaged.checksum, damaged.objectPath);
    assert.throws(() => persistence.recordFetch({ jobKey: job.key, status: 200, checksum: damaged.checksum, objectPath: damaged.objectPath }, job.lease, damagedRead), /checksum mismatch/);
    const workerPersistence = new InMemoryPersistence(() => new Date('2026-01-01T00:00:00.000Z'));
    workerPersistence.addJob({ key: 'job', pageType: 'season', sourceUrl: source, canonicalPath: canonicalizeSourceUrl(source) });
    const orchestrator = new IngestionOrchestrator({
      fetcher: { fetch: async () => ({ kind: 'fetched', sourceFetchId: 'fetch-damaged', checksum: damaged.checksum }) },
      discovery: {}, parsers: {}, normalizer: {}, persistence: workerPersistence, rawStore: store,
      clock: () => new Date('2026-01-01T00:00:00.000Z'),
    });
    await orchestrator.runOnce('worker');
    assert.equal(workerPersistence.getJob('job').state, 'operator_stop');
    assert.equal(workerPersistence.parseRuns.length, 0);
    assert.deepEqual(persistence.sourceFetches, before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
