import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryPersistence, MemoryRawStore, FileRawStore } from '../src/persistence/index.mjs';
import { createSourceUrl, canonicalizeSourceUrl } from '../src/contracts/source.mjs';
import { createJob } from '../src/contracts/boundaries.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function makeJob() {
  const sourceUrl = createSourceUrl('provider', 'https://allowed.example/page');
  return createJob({ key: 'provider:allowed.example/page:season', pageType: 'season', sourceUrl, canonicalPath: canonicalizeSourceUrl(sourceUrl) });
}

test('raw stores are immutable and checksum/path verification is strict', () => {
  const store = new MemoryRawStore();
  const first = store.put(Buffer.from('immutable body'));
  const returned = store.get(first.checksum);
  returned.body[0] = 0x58;
  assert.equal(store.get(first.checksum).body.toString(), 'immutable body');
  assert.equal(store.verify(first.checksum, first.objectPath).ok, true);
  assert.equal(store.verify('../escape').ok, false);
  assert.equal(store.verify(first.checksum, 'memory://wrong').reason, 'raw object path mismatch');
});

test('filesystem raw objects use content-addressed immutable paths and reject invalid references', () => {
  const root = mkdtempSync(join(tmpdir(), 'web-scraper-raw-'));
  try {
    const store = new FileRawStore(root);
    const first = store.put(Buffer.from('file body'));
    assert.equal(store.verify(first.checksum, first.objectPath).ok, true);
    assert.equal(store.get('../../etc/passwd'), null);
    assert.equal(store.verify('../../etc/passwd').ok, false);
    assert.equal(store.entries().length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('persistence refuses successful fetch metadata without a verified immutable body', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  const persistence = new InMemoryPersistence(() => now);
  const job = makeJob();
  persistence.addJob(job);
  const claimed = persistence.claimNextJob(now, 'worker');
  assert.throws(() => persistence.recordFetch({ jobKey: job.key, status: 200, checksum: 'a'.repeat(64) }, claimed.lease), /object path is missing/);
  assert.throws(() => persistence.recordFetch({ jobKey: job.key, status: 200, checksum: 'a'.repeat(64), objectPath: 'memory://unverified' }, claimed.lease), /requires a raw store/);
  assert.throws(() => persistence.recordFetch({ jobKey: job.key, status: 200, checksum: 'a'.repeat(64), objectPath: 'memory://missing' }, claimed.lease, new MemoryRawStore()), /missing raw object/);
  const store = new MemoryRawStore();
  const raw = store.put(Buffer.from('durable'));
  assert.match(persistence.recordFetch({ jobKey: job.key, status: 200, checksum: raw.checksum, objectPath: raw.objectPath }, claimed.lease, store), /^fetch-/);
});
