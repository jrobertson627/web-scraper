import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FileRawStore, InMemoryPersistence, MemoryRawStore, inventoryRawObjects, normalizeObjectReference, rawObjectKey,
} from '../src/persistence/index.mjs';
import { RawStoreMismatchError, assertRawStoreMatchesDatabase } from '../src/persistence/raw-store-identity.mjs';

// #117: a raw object is recorded by a reference that does not depend on the
// machine or directory that wrote it, and a database records which raw store its
// objects live in.

const CHECKSUM = 'ab'.repeat(32);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function withDirectories(count, run) {
  const roots = Array.from({ length: count }, () => mkdtempSync(join(tmpdir(), 'raw-identity-')));
  const cleanup = () => roots.forEach((root) => rmSync(root, { recursive: true, force: true }));
  return Promise.resolve(run(...roots)).finally(cleanup);
}

test('an object reference is the first two hex digits and the checksum, whatever the root', () => {
  assert.equal(rawObjectKey(CHECKSUM), `raw:ab/${CHECKSUM}`);
  assert.throws(() => rawObjectKey('not-a-checksum'), /raw checksum is invalid/);
});

test('legacy file:// and memory:// paths are read as the same object, and nothing else is guessed at', () => {
  const key = rawObjectKey(CHECKSUM);
  assert.equal(normalizeObjectReference(key), key);
  assert.equal(normalizeObjectReference(`file:///var/data/raw/ab/${CHECKSUM}`), key);
  assert.equal(normalizeObjectReference(`file://C:\\data\\raw\\ab\\${CHECKSUM}`), key);
  assert.equal(normalizeObjectReference(`file:///other/machine/raw/ab/${CHECKSUM}`), key);
  assert.equal(normalizeObjectReference(`memory://${CHECKSUM}`), key);
  for (const other of ['file://wrong', 'memory://wrong', 'raw:zz/wrong', 'https://example.com/x', '', undefined, null]) {
    assert.equal(normalizeObjectReference(other), other, String(other));
  }
});

test('both stores record the same root-independent reference', () => withDirectories(2, async (first, second) => {
  const body = Buffer.from('a body');
  const memory = new MemoryRawStore().put(body);
  const one = await new FileRawStore(first).put(body);
  const two = await new FileRawStore(second).put(body);
  assert.equal(one.objectPath, two.objectPath, 'two roots record one reference');
  assert.equal(memory.objectPath, one.objectPath);
  assert.match(one.objectPath, /^raw:[a-f0-9]{2}\/[a-f0-9]{64}$/);
  assert.doesNotMatch(one.objectPath, new RegExp(first.replaceAll('\\', '\\\\')), 'the worker\'s path is not in the reference');
}));

test('a store moved to a new root keeps every recorded reference readable and keeps its identity', () => withDirectories(2, async (original, moved) => {
  const before = new FileRawStore(original);
  const stored = await before.put(Buffer.from('durable body'));
  const id = await before.storeId();
  cpSync(original, moved, { recursive: true });
  rmSync(original, { recursive: true, force: true });
  const after = new FileRawStore(moved);
  assert.equal((await after.read(stored.checksum, stored.objectPath)).body.toString(), 'durable body');
  assert.equal(await after.storeId(), id, 'the marker file moves with the store');
  // A reference recorded before #117, with the old root in it, still resolves.
  assert.equal((await after.read(stored.checksum, `file://${original}/${stored.checksum.slice(0, 2)}/${stored.checksum}`)).ok, true);
  assert.equal((await after.read(stored.checksum, 'file://wrong')).reason, 'raw object path mismatch');
}));

test('a store\'s id is a UUID in a marker file, created once, and the marker is not an object', () => withDirectories(1, async (root) => {
  const store = new FileRawStore(root);
  const id = await store.storeId();
  assert.match(id, UUID);
  assert.equal(await store.storeId(), id);
  assert.equal(await new FileRawStore(root).storeId(), id, 'a new instance on the same root reads the same id');
  assert.equal(readFileSync(join(root, '.raw-store-id'), 'utf8').trim(), id);
  assert.deepEqual(await store.entries(), [], 'the marker is not an orphan object');
  assert.equal((await inventoryRawObjects({ rawStore: store, fetches: [], observedAt: 'now' })).counts.orphans, 0);
  writeFileSync(join(root, '.raw-store-id'), 'not a uuid');
  await assert.rejects(new FileRawStore(root).storeId(), /malformed/);
  assert.match(new MemoryRawStore().storeId(), UUID);
  assert.notEqual(new MemoryRawStore().storeId(), new MemoryRawStore().storeId());
}));

test('the repair inventory treats objects recorded under a legacy path as healthy', () => withDirectories(1, async (root) => {
  const store = new FileRawStore(root);
  const stored = await store.put(Buffer.from('durable body'));
  const legacy = { id: 'fetch-1', checksum: stored.checksum, objectPath: `file:///old/machine/raw/${stored.checksum.slice(0, 2)}/${stored.checksum}` };
  const report = await inventoryRawObjects({ rawStore: store, fetches: [legacy], observedAt: 'now' });
  assert.deepEqual(report.counts, { healthy: 1, pending: 0, orphans: 0, temporary: 0 });
  assert.equal(report.healthy[0].objectPath, stored.objectPath);
}));

test('an interrupted write is listed relative to the store, not by the worker\'s path', () => withDirectories(1, async (root) => {
  const store = new FileRawStore(root);
  const stored = await store.put(Buffer.from('a body'));
  const shard = stored.checksum.slice(0, 2);
  writeFileSync(join(root, shard, `${stored.checksum}.123.abcd-ef.tmp`), 'partial');
  const [temporary] = await store.temporaryEntries();
  assert.equal(temporary.objectPath, `raw:${shard}/${stored.checksum}.123.abcd-ef.tmp`);
}));

test('the first worker records its raw store, and another store then refuses', () => withDirectories(2, async (production, elsewhere) => {
  const persistence = new InMemoryPersistence();
  const store = new FileRawStore(production);
  assert.equal(persistence.rawStoreId(), null);
  assert.equal(await assertRawStoreMatchesDatabase({ persistence, rawStore: store }), await store.storeId(), 'checking alone records nothing');
  assert.equal(persistence.rawStoreId(), null);
  await assertRawStoreMatchesDatabase({ persistence, rawStore: store, claim: true });
  assert.equal(persistence.rawStoreId(), await store.storeId());
  await assertRawStoreMatchesDatabase({ persistence, rawStore: store, claim: true });

  const other = new FileRawStore(elsewhere);
  const refusal = await assertRawStoreMatchesDatabase({ persistence, rawStore: other, claim: true }).catch((error) => error);
  assert.ok(refusal instanceof RawStoreMismatchError);
  assert.equal(refusal.exit, 'configurationRejected');
  assert.match(refusal.message, /not the one this database was crawled with/);
  assert.ok(refusal.message.includes(await store.storeId()) && refusal.message.includes(await other.storeId()), 'both ids are named');
  assert.match(refusal.message, /\.raw-store-id/);
  // Reprocess, review and repair only check, and a mismatch stops them too.
  await assert.rejects(assertRawStoreMatchesDatabase({ persistence, rawStore: other }), RawStoreMismatchError);
}));

test('a store without an id, or a persistence without one, is not checked', async () => {
  const persistence = new InMemoryPersistence();
  assert.equal(await assertRawStoreMatchesDatabase({ persistence, rawStore: {} }), null);
  assert.equal(await assertRawStoreMatchesDatabase({ persistence: {}, rawStore: new MemoryRawStore() }), null);
});

test('migration 014 rewrites recorded paths, records the store identity, and is repeat-safe', () => {
  const sql = readFileSync(join(process.cwd(), 'migrations', '014_raw_store_identity.sql'), 'utf8');
  assert.match(sql, /UPDATE source_fetches[\s\S]*'raw:' \|\| substr\(checksum, 1, 2\) \|\| '\/' \|\| checksum[\s\S]*raw_object_path ~ '\^\(file\|memory\):\/\/'/);
  assert.match(sql, /UPDATE raw_object_repair[\s\S]*object_path ~ '\^\(file\|memory\):\/\/'/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS raw_store_identity[\s\S]*singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK \(singleton\)/);
  assert.match(sql, /INSERT INTO schema_migrations\(version\) VALUES \('014_raw_store_identity'\) ON CONFLICT \(version\) DO NOTHING/);
});
