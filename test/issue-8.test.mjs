import test from 'node:test';
import assert from 'node:assert/strict';
import { createSourceUrl, canonicalizeSourceUrl } from '../src/contracts/source.mjs';
import { createFixtureApplication } from '../src/application/composition-root.mjs';
import { IngestionOrchestrator } from '../src/application/orchestrator.mjs';
import { InMemoryPersistence, MemoryRawStore } from '../src/persistence/index.mjs';
import { ParserRegistry } from '../src/parsers/index.mjs';

function job(key = 'parent') {
  const sourceUrl = createSourceUrl('provider', `https://allowed.example/${key}`);
  return { key, pageType: 'season', sourceUrl, canonicalPath: canonicalizeSourceUrl(sourceUrl) };
}

test('page effects and final transition install atomically after validation', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  const persistence = new InMemoryPersistence(() => now);
  persistence.addJob(job());
  const claimed = persistence.claimNextJob(now, 'worker');
  persistence.transitionJob(claimed.key, 'fetched', claimed.lease);
  const page = { jobKey: claimed.key, identity: 'page', kind: 'season', data: { endingYear: 2026 }, observations: [{ kind: 'season', parentKey: claimed.key, rowIndex: 0 }], childJobs: [{ ...job('child'), pageType: 'invalid' }] };
  assert.throws(() => persistence.commitPageAndTransition(page, { sourceFetchId: 'fetch-1' }, claimed.lease), /invalid page type/);
  assert.equal(persistence.getJob(claimed.key).state, 'fetched');
  assert.equal(persistence.pages.size, 0);
  assert.equal(persistence.observations.size, 0);
  assert.equal(persistence.listJobs().length, 1);

  const result = persistence.commitPageAndTransition({ ...page, childJobs: [job('child')] }, { sourceFetchId: 'fetch-1' }, claimed.lease);
  assert.deepEqual(result, { key: 'page', conflict: false });
  assert.equal(persistence.getJob(claimed.key).state, 'parsed');
  assert.equal(persistence.pages.size, 1);
  assert.equal(persistence.observations.size, 1);
  assert.equal(persistence.getJob('child').state, 'pending');
});

test('an illegal final transition leaves page effects untouched', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  const persistence = new InMemoryPersistence(() => now);
  persistence.addJob(job());
  const claimed = persistence.claimNextJob(now, 'worker');
  assert.throws(() => persistence.commitPageAndTransition({ jobKey: claimed.key, identity: 'page', kind: 'season', data: {} }, { sourceFetchId: 'fetch-1' }, claimed.lease), /illegal job transition/);
  assert.equal(persistence.getJob(claimed.key).state, 'fetching');
  assert.equal(persistence.pages.size, 0);
});

test('fixture preview is deterministic and makes no transport or persistence changes', () => {
  const app = createFixtureApplication();
  const preview = app.previewDryRun();
  assert.deepEqual(preview.pageTypes, { school_index: 1, school_history: 1, season: 2, game_log: 2 });
  assert.equal(preview.uniquePreBackfillUrls, 6);
  assert.equal(preview.boxScoreLinks, 1);
  assert.equal(preview.unavailableCoverage, 3);
  assert.equal(preview.estimatedMinimumRuntimeMs, 30_000);
  assert.equal(app.transport.calls.length, 0);
  assert.equal(app.persistence.listJobs().length, 1);
});

test('worker emits typed progress and local reads remain available after it stops', async () => {
  const app = createFixtureApplication();
  app.lifecycle.ready();
  app.lifecycle.running();
  const result = await app.runWorkerOnce();
  app.lifecycle.stop();
  assert.equal(result.events.length, 7);
  assert.equal(result.events.every((event) => event.kind === 'parsed' && event.jobKey && event.pageType), true);
  const priorCalls = app.transport.calls.length;
  const priorJobs = app.persistence.listJobs().length;
  const game = (await app.queries.listGames())[0];
  const server = app.createApiServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const detail = await fetch(`${base}/games/${encodeURIComponent(game.gameKey)}`);
    assert.equal(detail.status, 200);
    assert.equal((await detail.json()).provenance.sourceFetchId, game.provenance.sourceFetchId);
    const health = await fetch(`${base}/health`).then((response) => response.json());
    assert.equal(health.jobStates.parsed, 7);
    assert.equal(health.unavailableCoverage, 3);
    assert.equal((await fetch(`${base}/games/missing`)).status, 404);
    assert.equal((await fetch(`${base}/games`, { method: 'POST' })).status, 405);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
  assert.equal(app.transport.calls.length, priorCalls);
  assert.equal(app.persistence.listJobs().length, priorJobs);
});

test('worker reports operator stops and structural parse failures', async () => {
  const now = new Date('2026-01-01T00:00:00Z');
  const clock = () => now;
  const stopped = new InMemoryPersistence(clock);
  stopped.addJob(job('challenge'));
  const stopOrchestrator = new IngestionOrchestrator({
    fetcher: { fetch: async () => ({ kind: 'operator_stop', reason: 'challenge response' }) },
    persistence: stopped, clock,
  });
  const stopResult = await stopOrchestrator.runOnce();
  assert.equal(stopResult.events[0].kind, 'operator_stop');
  assert.equal(stopped.getJob('challenge').state, 'operator_stop');

  const rawStore = new MemoryRawStore();
  const raw = rawStore.put(Buffer.from('{"layoutShift":true}'));
  const failed = new InMemoryPersistence(clock);
  failed.addJob(job('shifted'));
  const parsers = new ParserRegistry().register({
    pageType: () => 'season', version: () => '1',
    parse: () => ({ kind: 'structural_failure', error: 'layout shifted', warnings: ['unrecognized column'] }),
  });
  const parseOrchestrator = new IngestionOrchestrator({
    fetcher: { fetch: async () => ({ kind: 'fetched', sourceFetchId: 'fetch-1', checksum: raw.checksum }) },
    parsers, persistence: failed, rawStore, clock,
  });
  const parseResult = await parseOrchestrator.runOnce();
  assert.equal(parseResult.events[0].kind, 'parse_failed');
  assert.deepEqual(parseResult.events[0].warnings, ['unrecognized column']);
  assert.equal(failed.getJob('shifted').state, 'parse_failed');
});
