import test from 'node:test';
import assert from 'node:assert/strict';
import { createJob } from '../src/contracts/boundaries.mjs';
import { createSourceUrl, canonicalizeSourceUrl, sourceKey } from '../src/contracts/source.mjs';
import { InMemoryPersistence, MemoryRawStore } from '../src/persistence/index.mjs';
import { createFixtureApplication } from '../src/application/composition-root.mjs';
import { schoolIndexDocument } from '../src/application/fixture-documents.mjs';

const INDEX = 'https://fixture.example/cbb/schools/';
const OTHER = 'https://fixture.example/cbb/schools/?page=2';

function indexJob(url) {
  const sourceUrl = createSourceUrl('fixture-provider', url);
  const canonicalPath = canonicalizeSourceUrl(sourceUrl);
  return createJob({ key: sourceKey(canonicalPath, 'school_index'), pageType: 'school_index', sourceUrl, canonicalPath });
}

// A raw store whose disk is full for one page's body.
class FullDiskRawStore extends MemoryRawStore {
  put(bytes) {
    if (Buffer.from(bytes).includes('Unwritable School')) throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
    return super.put(bytes);
  }
}

function crawl() {
  let milliseconds = Date.parse('2026-01-01T00:00:00.000Z');
  const clock = () => new Date(milliseconds);
  const sleep = async (ms) => { milliseconds += ms; };
  const persistence = new InMemoryPersistence(clock, { claimTimeoutMs: 30_000 });
  const app = createFixtureApplication({
    fixtureEntries: [
      { url: INDEX, body: JSON.stringify(schoolIndexDocument([{ path: '/school/z', name: 'Unwritable School', to: 2025 }])) },
      { url: OTHER, body: JSON.stringify(schoolIndexDocument([])) },
    ],
    sharedState: { clock, sleep, persistence, rawStore: new FullDiskRawStore() },
  });
  persistence.addJob(indexJob(OTHER));
  return { app, persistence, clock, advance: (ms) => { milliseconds += ms; } };
}

test('a raw-store write failure on one job leaves the run processing other jobs', async () => {
  const { app, persistence } = crawl();
  const result = await app.runWorkerOnce();

  // The failing job is claimed first; its error must not stop the run.
  assert.equal(result.events[0].kind, 'retry_wait');
  assert.equal(result.events[0].jobKey, indexJob(INDEX).key);
  assert.ok(result.events.some((event) => event.kind === 'parsed' && event.jobKey === indexJob(OTHER).key));
  const failed = persistence.getJob(indexJob(INDEX).key);
  assert.notEqual(failed.state, 'fetching');
  assert.equal(failed.claim, null);
  assert.match(failed.lastError, /fetch failed: ENOSPC/);
  assert.equal(persistence.getJob(indexJob(OTHER).key).state, 'parsed');
  assert.equal(persistence.inFlight.size, 0);
});

test('a job that fails the same way on every attempt ends permanently_failed after maxAttempts with the reason recorded', async () => {
  const { app, persistence, clock, advance } = crawl();
  const key = indexJob(INDEX).key;
  for (let run = 0; run < 10 && persistence.getJob(key).state !== 'permanently_failed'; run += 1) {
    await app.runWorkerOnce();
    const waiting = persistence.getJob(key);
    if (waiting.state === 'retry_wait') advance(Math.max(0, Date.parse(waiting.nextAllowedAt) - clock().getTime()));
  }
  const failed = persistence.getJob(key);
  assert.equal(failed.state, 'permanently_failed');
  assert.equal(failed.failures.filter((failure) => failure.state === 'retry_wait').length, app.config.policy.maxAttempts - 1);
  assert.match(failed.lastError, /ENOSPC.*retry limit reached/);
  assert.match(failed.failures.at(-1).reason, /ENOSPC/);
});

test('claim recovery moves a job whose worker keeps disappearing to permanently_failed at its own cap', () => {
  let milliseconds = Date.parse('2026-01-01T00:00:00.000Z');
  const clock = () => new Date(milliseconds);
  const persistence = new InMemoryPersistence(clock, { claimTimeoutMs: 10_000, maxClaimRecoveries: 3 });
  const job = indexJob(INDEX);
  persistence.addJob(job);
  for (let recovery = 1; recovery <= 3; recovery += 1) {
    const claimed = persistence.claimNextJob(clock(), `crashing-worker-${recovery}`);
    assert.equal(claimed.key, job.key);
    if (recovery === 2) persistence.transitionJob(job.key, 'fetched', claimed.lease);
    milliseconds += 10_001;
    assert.equal(persistence.recoverExpiredClaims(), 1);
    assert.equal(persistence.getJob(job.key).claimRecoveries, recovery);
  }
  const failed = persistence.getJob(job.key);
  assert.equal(failed.state, 'permanently_failed');
  assert.match(failed.lastError, /claim recovery limit reached/);
  assert.equal(failed.failures.at(-1).details.claimRecoveries, 3);
  assert.equal(persistence.claimNextJob(clock(), 'worker'), null);
});
