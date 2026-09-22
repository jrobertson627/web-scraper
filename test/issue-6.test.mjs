import test from 'node:test';
import assert from 'node:assert/strict';
import { createFixtureApplication } from '../src/application/composition-root.mjs';
import { FixtureParser } from '../src/parsers/index.mjs';
import { runCli } from '../src/application/cli.mjs';
import { foundationCorpus } from '../fixtures/foundation-corpus.mjs';
import { spawnSync } from 'node:child_process';

test('unit: raw HTML fixture documents parse and layout shifts fail closed', () => {
  const corpus = foundationCorpus({ faults: true });
  const index = new FixtureParser('school_index').parse({ body: Buffer.from(corpus[0].body) });
  assert.equal(index.kind, 'valid');
  assert.equal(index.document.schools.length, 3);
  const shifted = new FixtureParser('box_score').parse({ body: Buffer.from(corpus.at(-1).body) });
  assert.equal(shifted.kind, 'structural_failure');
});

test('integration: full HTML fixture chain is isolated, reconciles, and is idempotent across composition restart', async () => {
  const fixtures = foundationCorpus();
  const app = createFixtureApplication({ fixtureEntries: fixtures });
  const preview = app.previewDryRun();
  assert.equal(preview.uniquePreBackfillUrls, 9);
  assert.equal(preview.boxScoreLinks, 6);
  assert.equal(preview.unavailableCoverage, 7);
  assert.equal(app.transport.calls.length, 0);

  const first = await app.runWorkerOnce();
  assert.equal(first.jobs.every((job) => job.state === 'parsed'), true);
  assert.equal(first.transportCalls, fixtures.length);
  assert.equal(app.persistence.queryModels().games.length, 6);
  const canonicalGame = app.persistence.queryModels().games.find((game) => game.home === 'Fixture A' && game.status === 'final');
  assert.deepEqual(canonicalGame.valueStates, {
    blank: { state: 'blank' }, unavailable: { state: 'unavailable', reason: 'not_published' },
    null: { state: 'null' }, zero: { state: 'present', value: 0 },
  });
  assert.equal(app.persistence.queryModels().schools.filter((school) => school.eligible).length, 2);
  assert.equal(app.persistence.observations.size > 0, true);
  assert.deepEqual(app.transport.calls.sort(), fixtures.map((fixture) => fixture.url).sort());
  assert.deepEqual(app.reconcile().checks.filter((check) => !check.passed), []);

  const before = {
    pages: app.persistence.pages.size,
    observations: app.persistence.observations.size,
    observationHistory: app.persistence.observationHistory.length,
    fetches: app.persistence.sourceFetches.length,
    calls: app.transport.calls.length,
  };
  const resumed = createFixtureApplication({ fixtureEntries: fixtures, sharedState: {
    persistence: app.persistence, rawStore: app.rawStore, transport: app.transport,
  } });
  const second = await resumed.runWorkerOnce('restarted-fixture-worker');
  assert.equal(second.processed, 0);
  assert.equal(resumed.reconcile().passed, true);
  assert.deepEqual({
    pages: app.persistence.pages.size,
    observations: app.persistence.observations.size,
    observationHistory: app.persistence.observationHistory.length,
    fetches: app.persistence.sourceFetches.length,
    calls: app.transport.calls.length,
  }, before);
});

test('integration: a new worker composition recovers an expired claim after a simulated crash', async () => {
  let milliseconds = Date.parse('2026-01-01T00:00:00Z');
  const clock = () => new Date(milliseconds);
  const sleep = async (duration) => { milliseconds += duration; };
  const fixtures = foundationCorpus();
  const first = createFixtureApplication({ fixtureEntries: fixtures, sharedState: { clock, sleep } });
  const abandoned = first.persistence.claimNextJob(clock(), 'crashed-worker');
  assert.equal(abandoned.state, 'fetching');
  milliseconds += first.config.claimTimeoutMs + 1;

  const restarted = createFixtureApplication({ fixtureEntries: fixtures, sharedState: {
    clock, sleep, persistence: first.persistence, rawStore: first.rawStore, transport: first.transport,
  } });
  const result = await restarted.runWorkerOnce('replacement-worker');
  assert.equal(result.jobs.every((job) => job.state === 'parsed'), true);
  assert.equal(restarted.persistence.getJob(abandoned.key).attempts, 2);
  assert.equal(restarted.persistence.getJob(abandoned.key).history.some((event) => event.to === 'retry_wait'), true);
  assert.equal(restarted.transport.calls.length, fixtures.length);
  assert.equal(restarted.reconcile().passed, true);
});

test('integration: shifted layout and off-host link identify exact quarantined records', async () => {
  const app = createFixtureApplication({ fixtureEntries: foundationCorpus({ faults: true }) });
  await app.runWorkerOnce();
  const report = app.reconcile();
  assert.equal(report.passed, false);
  const resolution = report.checks.find((check) => check.id === 'linked_game_resolution');
  assert.equal(resolution.passed, false);
  assert.match(resolution.records[0].jobKey, /box\/shift/);
  assert.equal(resolution.records[0].state, 'parse_failed');
  assert.equal(report.checks.find((check) => check.id === 'layout_shift_quarantine').passed, true);
  assert.equal(report.quarantined.some((item) => /box\/shift/.test(item.key)), true);
  assert.equal(report.quarantined.some((item) => /outside\.example/.test(item.reason) || /allowlisted/.test(item.reason)), true);
  assert.equal(app.transport.calls.some((url) => url.includes('outside.example')), false);
});

test('integration: reconciliation identifies incorrect winners and mismatched log totals', async () => {
  const fixtures = foundationCorpus().map((fixture) => {
    if (fixture.url.endsWith('/box/one.html')) return { ...fixture, body: fixture.body.replace('"winner":"Fixture A"', '"winner":"Fixture B"') };
    if (fixture.url.endsWith('/school/a/men/2026-gamelogs.html')) return { ...fixture, body: fixture.body.replace('"homeScore":70', '"homeScore":71') };
    return fixture;
  });
  const app = createFixtureApplication({ fixtureEntries: fixtures });
  await app.runWorkerOnce();
  const report = app.reconcile();
  assert.equal(report.passed, false);
  const winner = report.checks.find((check) => check.id === 'winner_matches_final_scores');
  assert.equal(winner.records[0].expectedWinner, 'Fixture A');
  assert.equal(winner.records[0].winner, 'Fixture B');
  const totals = report.checks.find((check) => check.id === 'box_score_game_log_totals');
  assert.equal(totals.records[0].field, 'homeScore');
  assert.equal(totals.records[0].gameLog, 71);
  assert.equal(totals.records[0].boxScore, 70);
});

test('smoke: local read API remains available after fixture worker completion', async () => {
  const app = createFixtureApplication({ fixtureEntries: foundationCorpus() });
  await app.runWorkerOnce();
  const server = app.createApiServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const before = app.transport.calls.length;
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).jobStates.parsed, foundationCorpus().length);
    const games = await fetch(`${base}/games`).then((response) => response.json());
    assert.equal(games.length, 6);
    assert.equal((await fetch(`${base}/games/${encodeURIComponent(games[0].gameKey)}`)).status, 200);
    assert.equal((await fetch(`${base}/games`, { method: 'POST' })).status, 405);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
  assert.equal(app.transport.calls.length, before);
});

test('smoke: selected local command reports readiness and PostgreSQL smoke refuses an unconfirmed target', async () => {
  const output = [];
  const result = await runCli({ mode: 'local', stdout: (line) => output.push(line) });
  assert.equal(result.exitCode, 0);
  assert.equal(output[0], 'fixture local ready');
  assert.equal(JSON.parse(output[1]).jobs.every((job) => job.state === 'parsed'), true);

  const child = spawnSync(process.execPath, ['scripts/migration-smoke.mjs'], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8',
    env: { ...process.env, PG_SMOKE_CONFIRM: '', PGHOST: '', PGDATABASE: '', PGUSER: '' },
  });
  assert.equal(child.status, 2);
  assert.match(child.stderr, /disposable PostgreSQL database/);
});
