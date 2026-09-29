import assert from 'node:assert/strict';
import { createFixtureApplication } from '../src/application/composition-root.mjs';
import { BOUNDARY_PORT_METHODS, assertBoundaryPort } from '../src/contracts/boundaries.mjs';
import { InMemoryPersistence, MemoryRawStore } from '../src/persistence/index.mjs';
import { buildManifestReport } from '../src/application/manifest.mjs';
import { CRAWL_STAGES } from '../src/contracts/crawl-scope.mjs';
import { foundationCorpus } from './foundation-corpus.mjs';

// One behavior suite for both persistence adapters (#46). Each scenario crawls
// the same fixture corpus into the adapter under test and must give the same
// outcome as the in-memory reference: the reconciliation report, the
// reconciliation reads it is built on, health counts, and the raw repair
// inventory. test/persistence-conformance.test.mjs runs it for the in-memory
// adapter; scripts/postgres-integration.mjs runs it for PostgreSQL.
//
// createStores() returns { persistence, rawStore } for a fresh, empty store.

const PORTS = ['persistence', 'persistenceReads', 'persistenceReprocess', 'persistenceReview', 'persistenceReconciliation'];

async function crawl({ persistence, rawStore }, faults) {
  const app = createFixtureApplication({ fixtureEntries: foundationCorpus({ faults }), sharedState: { persistence, rawStore } });
  await app.runWorkerOnce();
  return app;
}

async function reference(faults) {
  const stores = { persistence: new InMemoryPersistence(), rawStore: new MemoryRawStore() };
  return { ...stores, app: await crawl(stores, faults) };
}

// Values that differ by adapter or run, not by behavior: generated ids and times.
function comparable(value) {
  return JSON.parse(JSON.stringify(value, (key, entry) => (['observedAt', 'id', 'sourceFetchIds', 'objectPath'].includes(key) ? undefined : entry)));
}

export function definePersistenceConformance(test, { label, createStores }) {
  test(`${label}: implements every persistence port`, async () => {
    const { persistence } = await createStores();
    for (const port of PORTS) assertBoundaryPort(port, persistence);
    assert.ok(PORTS.every((port) => BOUNDARY_PORT_METHODS[port]));
  });

  for (const faults of [false, true]) {
    test(`${label}: the ${faults ? 'fault' : 'clean'} corpus reconciles exactly as the in-memory reference does`, async () => {
      const stores = await createStores();
      const app = await crawl(stores, faults);
      const expected = await (await reference(faults)).app.reconcile();
      const report = await app.reconcile();
      assert.deepEqual(report, expected);
      assert.equal(report.passed, !faults);
      if (faults) assert.ok(report.quarantined.some((entry) => entry.key === 'fixture-provider:fixture.example/box/shift.html:box_score'));
    });
  }

  test(`${label}: the reconciliation reads return the in-memory reference's records`, async () => {
    const stores = await createStores();
    await crawl(stores, true);
    const { persistence: expected } = await reference(true);
    const actual = stores.persistence;
    const byKey = (list) => [...list].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    assert.deepEqual(byKey((await actual.reconciliationJobs()).map(comparable)), byKey(expected.reconciliationJobs().map(comparable)));
    const keys = expected.reconciliationJobs().filter((job) => job.state === 'parsed').map((job) => (job.pageType === 'box_score'
      ? `${job.canonicalPath.providerId}:${job.canonicalPath.host}${job.canonicalPath.path}` : job.key));
    assert.deepEqual(byKey((await actual.acceptedPages(keys)).map(comparable)), byKey(expected.acceptedPages(keys).map(comparable)));
    const parents = expected.reconciliationJobs().map((job) => job.key);
    assert.deepEqual(byKey((await actual.acceptedObservations(parents)).map(comparable)), byKey(expected.acceptedObservations(parents).map(comparable)));
    assert.deepEqual(byKey(await actual.coverageGaps()), byKey(expected.coverageGaps()));
    assert.deepEqual(await actual.failedParses(), expected.failedParses());
    assert.deepEqual((await actual.openIssues()).map(comparable), expected.openIssues().map(comparable));
    assert.deepEqual(byKey((await actual.rejectedUrls()).map(comparable)), byKey(expected.rejectedUrls().map(comparable)));
  });

  test(`${label}: job counts and health counts match the in-memory reference`, async () => {
    const stores = await createStores();
    await crawl(stores, true);
    const { persistence: expected } = await reference(true);
    assert.deepEqual(await stores.persistence.jobCounts(), expected.jobCounts());
    assert.deepEqual(comparable(await stores.persistence.health()), comparable(expected.health()));
  });

  test(`${label}: records the crawl scope, widens a sample by rediscovery, and refuses to narrow`, async () => {
    const stores = await createStores();
    const sample = { schools: ['/school/a'], endingYears: [2026] };
    await (createFixtureApplication({ fixtureEntries: foundationCorpus(), sharedState: stores, crawlScope: sample })).runWorkerOnce();
    assert.deepEqual(await stores.persistence.crawlScope(), { kind: 'sample', ...sample });
    assert.deepEqual((await stores.persistence.crawlStatus()).scope, { kind: 'sample', ...sample });
    const full = createFixtureApplication({ fixtureEntries: foundationCorpus(), sharedState: stores });
    await full.runWorkerOnce();
    assert.equal((await stores.persistence.crawlScope()).kind, 'full');
    assert.deepEqual(await full.reconcile(), await (await reference(false)).app.reconcile());
    await assert.rejects(async () => stores.persistence.recordCrawlScope(sample), /crawl scope refused/);
  });

  test(`${label}: a manifest run claims only index and history pages, and reports as the reference does`, async () => {
    const stores = await createStores();
    const app = createFixtureApplication({ fixtureEntries: foundationCorpus(), sharedState: stores });
    await app.runWorkerOnce('manifest-worker', { pageTypes: CRAWL_STAGES.manifest });
    const counts = await stores.persistence.jobCounts();
    assert.deepEqual(counts, { parsed: 3, pending: 3 });
    assert.deepEqual(await stores.persistence.workOutlook({ pageTypes: CRAWL_STAGES.manifest }), { remaining: 0, wakeInMs: null });
    assert.equal((await stores.persistence.workOutlook()).remaining, 3);
    const expected = new InMemoryPersistence();
    await createFixtureApplication({ fixtureEntries: foundationCorpus(), sharedState: { persistence: expected, rawStore: new MemoryRawStore() } })
      .runWorkerOnce('manifest-worker', { pageTypes: CRAWL_STAGES.manifest });
    assert.deepEqual(await buildManifestReport(stores.persistence), await buildManifestReport(expected));
  });

  test(`${label}: a challenge stop blocks the crawl until an operator reviews it`, async () => {
    const stores = await createStores();
    stores.persistence.authorizeOperator = (operatorId) => operatorId === 'ops';
    const app = createFixtureApplication({ fixtureEntries: foundationCorpus(), sharedState: stores });
    await app.ready;
    const stop = async (code) => {
      const claimed = await stores.persistence.claimNextJob(new Date(), 'conformance-worker');
      await stores.persistence.transitionJob(claimed.key, 'operator_stop', claimed.lease, { lastError: `${code} stop`, code });
      return claimed.key;
    };
    const review = (key, kind) => stores.persistence.recordOperatorDisposition(key, { kind, operatorId: 'ops', reason: kind,
      at: new Date(Date.now() - 60_000).toISOString() });
    const key = await stop('challenge');
    assert.deepEqual((await stores.persistence.unreviewedChallenges()).map((entry) => [entry.jobKey, entry.code]), [[key, 'challenge']]);
    await review(key, 'hold');
    assert.deepEqual(await stores.persistence.unreviewedChallenges(), [], 'a hold reviews the stop');
    await review(key, 'release_retry');
    assert.equal(await stop('challenge'), key, 'the released page is retried');
    assert.equal((await stores.persistence.unreviewedChallenges()).length, 1, 'the hold before the release does not review the new stop');
    await review(key, 'release_permanent');
    assert.deepEqual(await stores.persistence.unreviewedChallenges(), []);
  });

  test(`${label}: counts the jobs a worker holds a live claim on`, async () => {
    const stores = await createStores();
    const app = createFixtureApplication({ fixtureEntries: foundationCorpus(), sharedState: stores });
    await app.ready;
    assert.equal(await stores.persistence.liveClaimCount(), 0);
    await stores.persistence.claimNextJob(new Date(), 'conformance-worker');
    assert.equal(await stores.persistence.liveClaimCount(), 1);
  });

  test(`${label}: the raw repair inventory has the documented shape and finds an orphan`, async () => {
    const stores = await createStores();
    await crawl(stores, false);
    await stores.rawStore.put(Buffer.from('an object no fetch refers to'));
    const report = await stores.persistence.repairRawObjects({ rawStore: stores.rawStore });
    assert.deepEqual(Object.keys(report), ['observedAt', 'counts', 'healthy', 'pending', 'orphans', 'temporary']);
    const { persistence: expected } = await reference(false);
    assert.deepEqual(report.counts, { healthy: expected.sourceFetches.length ? new Set(expected.sourceFetches.map((fetch) => fetch.checksum)).size : 0,
      pending: 0, orphans: 1, temporary: 0 });
    assert.deepEqual(Object.keys(report.orphans[0]), ['checksum', 'objectPath', 'state', 'detectedAs', 'observedAt', 'reason']);
    assert.equal(report.orphans[0].reason, 'orphan raw object retained for operator review');
  });
}
