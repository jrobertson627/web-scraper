import test from 'node:test';
import assert from 'node:assert/strict';
import { createFixtureApplication } from '../src/application/composition-root.mjs';
import { EXIT_CODES, parseReviewArgs, runCli } from '../src/application/cli.mjs';
import { differingPaths, formatReviewList } from '../src/application/review.mjs';
import { operatorAllowlist, operatorAuthorizer } from '../src/config/operators.mjs';
import { createJob } from '../src/contracts/boundaries.mjs';
import { canonicalizeSourceUrl, createSourceUrl } from '../src/contracts/source.mjs';
import { InMemoryPersistence, MemoryRawStore } from '../src/persistence/index.mjs';
import { PostgresPersistence } from '../src/persistence/postgres.mjs';
import { foundationCorpus } from '../fixtures/foundation-corpus.mjs';

const T0 = '2026-01-01T00:00:00.000Z';
const BOX_ONE = 'fixture-provider:fixture.example/box/one.html:box_score';
const GAME_ONE = 'fixture-provider:fixture.example/box/one.html';
const SHIFT = 'fixture-provider:fixture.example/box/shift.html:box_score';
const reviewer = { operatorId: 'ops-1', reason: 'checked the source page' };

// The fault corpus crawled into a store whose reviewers are ops-1 and ops-2.
async function reviewedCrawl() {
  let time = Date.parse(T0);
  const clock = () => new Date(time);
  const persistence = new InMemoryPersistence(clock, { authorizeOperator: operatorAuthorizer('ops-1,ops-2') });
  const app = createFixtureApplication({ fixtureEntries: foundationCorpus({ faults: true }),
    sharedState: { persistence, rawStore: new MemoryRawStore(), clock, sleep: async (ms) => { time += ms; } } });
  await app.runWorkerOnce();
  return { app, persistence, advance: (ms) => { time += ms; } };
}

// A later fetch of box one returned a changed page (the source corrected it).
// Reprocessing reads that newer body and holds the difference as a conflict.
async function sourceChange(run, change) {
  const entry = foundationCorpus().find((item) => item.url.endsWith('/box/one.html'));
  const document = JSON.parse(/<script[^>]*>([\s\S]*?)<\/script>/.exec(entry.body)[1]);
  const body = entry.body.replace(/(<script[^>]*>)[\s\S]*?(<\/script>)/, `$1${JSON.stringify(change(document))}$2`);
  const stored = run.app.rawStore.put(Buffer.from(body));
  run.advance(1000);
  run.persistence.sourceFetches.push(Object.freeze({ id: `fetch-${run.persistence.sourceFetches.length + 1}`, jobKey: BOX_ONE, status: 200,
    checksum: stored.checksum, objectPath: stored.objectPath, fetchedAt: new Date(Date.parse(T0) + 10 ** 9).toISOString(), cacheHit: false }));
  const summary = await run.app.reprocess({ jobKeys: [BOX_ONE] });
  assert.equal(summary.conflicts, 1);
  return run.persistence.reconciliationIssues.at(-1).id;
}

const venue = (name) => (document) => ({ ...document, venue: name });

test('operator dispositions are denied unless the reviewer is on the allowlist', () => {
  const now = new Date(T0);
  const denied = new InMemoryPersistence(() => now);
  const sourceUrl = createSourceUrl('provider', 'https://allowed.example/page');
  denied.addJob(createJob({ key: 'job', pageType: 'season', sourceUrl, canonicalPath: canonicalizeSourceUrl(sourceUrl) }));
  const claimed = denied.claimNextJob(now, 'worker');
  denied.transitionJob('job', 'operator_stop', claimed.lease, { lastError: 'challenge' });
  assert.throws(() => denied.recordOperatorDisposition('job', { kind: 'release_retry', operatorId: 'anyone', reason: 'x' }), /not authorized/);
  assert.equal(new PostgresPersistence({ pool: { on() {} } }).authorizeOperator('anyone'), false, 'PostgreSQL denies by default too');

  assert.deepEqual(operatorAllowlist(''), []);
  assert.deepEqual(operatorAllowlist(' jessica , ops-2,jessica '), ['jessica', 'ops-2']);
  assert.throws(() => operatorAllowlist('jessica,drop table;'), /OPERATOR_IDS is invalid/);
  const allow = operatorAuthorizer('jessica');
  assert.equal(allow('jessica'), true);
  assert.equal(allow('Jessica'), false);
  assert.equal(allow(undefined), false);
  assert.equal(operatorAuthorizer(undefined)('jessica'), false, 'no allowlist means no reviewer');
});

test('the review list shows stopped and failed jobs with their parser, failure, snapshot and URL', async () => {
  const run = await reviewedCrawl();
  const extra = createSourceUrl('fixture-provider', 'https://fixture.example/box/challenged.html');
  run.persistence.addJob(createJob({ key: 'fixture-provider:fixture.example/box/challenged.html:box_score', pageType: 'box_score', sourceUrl: extra, canonicalPath: canonicalizeSourceUrl(extra) }));
  const claimed = run.persistence.claimNextJob(new Date(), 'worker');
  run.persistence.transitionJob(claimed.key, 'operator_stop', claimed.lease, { lastError: 'operator review required for challenge response' });

  const list = await run.app.review.list();
  assert.deepEqual(list.jobs.map((job) => [job.state, job.key]), [
    ['operator_stop', 'fixture-provider:fixture.example/box/challenged.html:box_score'],
    ['parse_failed', SHIFT],
  ]);
  const shift = list.jobs[1];
  assert.equal(shift.url, 'https://fixture.example/box/shift.html');
  assert.equal(shift.parser, 'box_score@1');
  assert.match(shift.reason, /fixture layout changed/);
  assert.deepEqual(list.issues, []);
  const text = formatReviewList(list);
  assert.match(text, /parse_failed\s+box_score\s+https:\/\/fixture\.example\/box\/shift\.html/);
  assert.match(text, /Open issues \(0\)\n  none/);

  const detail = await run.app.review.show(SHIFT);
  assert.equal(detail.kind, 'job');
  assert.equal(detail.lastParseRun.failureDetails.error, 'fixture layout changed; column meaning is uncertain');
  assert.match(detail.snapshot.checksum, /^[0-9a-f]{64}$/);
  assert.equal(detail.snapshot.objectPath, `raw:${detail.snapshot.checksum.slice(0, 2)}/${detail.snapshot.checksum}`);
  assert.deepEqual(detail.history.map((event) => event.to), ['fetching', 'fetched', 'parse_failed']);
  assert.match(detail.nextSteps.at(-1), /npm run reprocess -- --job fixture-provider:fixture\.example\/box\/shift\.html:box_score/);
  await assert.rejects(run.app.review.show('fixture-provider:fixture.example/nope:season'), /is not queued/);
});

test('an operator_stop job is held or released with a recorded disposition', async () => {
  const run = await reviewedCrawl();
  const extra = createSourceUrl('fixture-provider', 'https://fixture.example/box/challenged.html');
  const key = 'fixture-provider:fixture.example/box/challenged.html:box_score';
  run.persistence.addJob(createJob({ key, pageType: 'box_score', sourceUrl: extra, canonicalPath: canonicalizeSourceUrl(extra) }));
  const claimed = run.persistence.claimNextJob(new Date(), 'worker');
  run.persistence.transitionJob(key, 'operator_stop', claimed.lease, { lastError: 'challenge' });

  await assert.rejects(run.app.review.dispose(key, 'release-retry', { operatorId: 'intruder', reason: 'x' }), /not authorized/);
  const held = await run.app.review.dispose(key, 'hold', { operatorId: 'ops-1', reason: 'waiting for the provider' });
  assert.equal(held.state, 'operator_stop');
  const released = await run.app.review.dispose(key, 'release-retry', { operatorId: 'ops-2', reason: 'challenge cleared' });
  assert.equal(released.state, 'retry_wait');
  const detail = await run.app.review.show(key);
  assert.deepEqual(detail.dispositions.map(({ kind, operatorId, reason }) => [kind, operatorId, reason]),
    [['hold', 'ops-1', 'waiting for the provider'], ['release_retry', 'ops-2', 'challenge cleared']]);
  assert.ok(detail.dispositions.every((entry) => entry.at));
  await assert.rejects(run.app.review.dispose(key, 'restart', reviewer), /job action restart is invalid/);
});

test('accepting a quarantined revision makes it the accepted record and records who, when and why', async () => {
  const run = await reviewedCrawl();
  assert.equal(run.persistence.pages.get(GAME_ONE).data.venue, null);
  const issueId = await sourceChange(run, venue('Corrected Arena'));
  assert.equal(run.persistence.pages.get(GAME_ONE).data.venue, null, 'the accepted record stays until review');

  const list = await run.app.review.list({ jobs: false });
  assert.deepEqual(list.issues.map((issue) => [issue.id, issue.issueType, issue.recordKey]), [[issueId, 'conflicting_page_reprocess', GAME_ONE]]);
  assert.deepEqual(list.issues[0].changed, ['venue']);
  const detail = await run.app.review.show(issueId);
  assert.deepEqual(detail.changed, ['venue']);
  assert.equal(detail.quarantinedRevision.jobKey, BOX_ONE);
  assert.match(detail.nextSteps[0], new RegExp(`npm run review -- accept ${issueId}`));

  await assert.rejects(run.app.review.accept(issueId, { operatorId: 'intruder', reason: 'x' }), /not authorized/);
  const accepted = await run.app.review.accept(issueId, reviewer);
  assert.deepEqual({ kind: accepted.kind, operatorId: accepted.operatorId, reason: accepted.reason }, { kind: 'accept', ...reviewer });
  assert.ok(accepted.at);
  const game = run.persistence.pages.get(GAME_ONE);
  assert.equal(game.data.venue, 'Corrected Arena');
  assert.equal(game.provenance.sourceFetchId, detail.quarantinedRevision.sourceFetchId);
  const closed = await run.app.review.show(issueId);
  assert.equal(closed.status, 'accepted');
  assert.deepEqual(closed.dispositions.map(({ kind, operatorId }) => [kind, operatorId]), [['accept', 'ops-1']]);
  assert.deepEqual(closed.nextSteps, []);
  assert.deepEqual((await run.app.review.list()).issues, []);
  await assert.rejects(run.app.review.accept(issueId, reviewer), /already accepted/);
});

test('dismissing keeps the accepted record; an issue made stale by another accept is refused', async () => {
  const run = await reviewedCrawl();
  const first = await sourceChange(run, venue('Arena One'));
  const second = await sourceChange(run, venue('Arena Two'));
  await run.app.review.accept(first, reviewer);
  // The second issue compared against the record that has just been replaced.
  await assert.rejects(run.app.review.accept(second, reviewer), /accepted record changed since this issue opened/);
  const dismissed = await run.app.review.dismiss(second, { operatorId: 'ops-2', reason: 'superseded by the accepted correction' });
  assert.equal(dismissed.kind, 'dismiss');
  assert.equal(run.persistence.pages.get(GAME_ONE).data.venue, 'Arena One');
  assert.equal((await run.app.review.show(second)).status, 'resolved');
  await assert.rejects(run.app.review.dismiss(second, reviewer), /already resolved/);
  await assert.rejects(run.app.review.dismiss('issue-999', reviewer), /does not exist/);
  await assert.rejects(run.app.review.dismiss('12', reviewer), /issue id 12 is invalid/);
});

test('accept refuses a revision its stored snapshot no longer normalizes to', async () => {
  const run = await reviewedCrawl();
  const issueId = await sourceChange(run, venue('Arena'));
  // Simulate the data contract or parser changing after the issue opened.
  const index = run.persistence.reconciliationIssues.findIndex((issue) => issue.id === issueId);
  const issue = run.persistence.reconciliationIssues[index];
  run.persistence.reconciliationIssues[index] = Object.freeze({ ...issue,
    details: { ...issue.details, current: { ...issue.details.current, data: { ...issue.details.current.data, venue: 'Something Else' } } } });
  await assert.rejects(run.app.review.accept(issueId, reviewer), /no longer normalizes to the revision under review/);
  assert.equal(run.persistence.pages.get(GAME_ONE).data.venue, null);
});

test('differingPaths names the changed fields', () => {
  assert.deepEqual(differingPaths({ a: 1, b: { c: [1, 2] } }, { a: 1, b: { c: [1, 3] }, d: null }), ['b.c[1]', 'd']);
  assert.deepEqual(differingPaths(1, 1), []);
  assert.deepEqual(differingPaths({ a: 1 }, { a: 2 }, '', [], 0), []);
});

test('review arguments name a command, a target, and for an action the operator and reason', () => {
  assert.deepEqual(parseReviewArgs(['list']), { command: 'list' });
  assert.deepEqual(parseReviewArgs(['list', '--issues', '--json', '--limit', '5']), { command: 'list', jobs: false, json: true, limit: 5 });
  assert.deepEqual(parseReviewArgs(['list', '--state', 'operator_stop']), { command: 'list', states: ['operator_stop'] });
  assert.deepEqual(parseReviewArgs(['show', 'issue-3']), { command: 'show', target: 'issue-3' });
  assert.deepEqual(parseReviewArgs(['dismiss', 'issue-3', '--operator', 'jessica', '--reason', 'known quirk']),
    { command: 'dismiss', target: 'issue-3', operatorId: 'jessica', reason: 'known quirk' });
  assert.throws(() => parseReviewArgs([]), /review command \(none\) is invalid/);
  assert.throws(() => parseReviewArgs(['delete', 'x']), /review command delete is invalid/);
  assert.throws(() => parseReviewArgs(['accept', 'issue-3', '--operator', 'jessica']), /needs --operator <id> and --reason/);
  assert.throws(() => parseReviewArgs(['release-retry']), /needs a job key or issue id/);
  assert.throws(() => parseReviewArgs(['show', 'issue-3', '--operator', 'x']), /argument --operator is invalid/);
  assert.throws(() => parseReviewArgs(['list', '--limit', 'all']), /--limit is invalid/);
});

// Reads answer from memory; the pool is never queried.
class ReviewPostgres extends PostgresPersistence {
  async rawStoreId() { return null; }
  async claimRawStoreId(storeId) { return storeId; }
  constructor(options) { super({ pool: { end: async () => {} }, ...options }); this.closed = 0; }
  async reviewJobs() { return { items: [], nextCursor: null }; }
  async reviewIssues() { return { items: [], nextCursor: null }; }
  async close() { this.closed += 1; }
}

test('review mode reads PostgreSQL and records a disposition only for a listed reviewer', async () => {
  const env = { PERSISTENCE: 'postgres', PGHOST: 'db.internal', PGDATABASE: 'scraper', PGUSER: 'scraper', PGPASSWORD: 'TOP_SECRET' };
  const output = [];
  const errors = [];
  let opened;
  const run = (overrides, args) => runCli({ mode: 'review', env: { ...env, ...overrides }, args, stdout: (line) => output.push(line),
    stderr: (line) => errors.push(line), openPostgres: async (settings) => { opened = new ReviewPostgres({ authorizeOperator: settings.authorizeOperator }); return opened; } });

  assert.equal((await run({}, ['list'])).exitCode, EXIT_CODES.success);
  assert.match(output.at(-1), /Jobs to review \(0\)/);
  assert.equal(opened.closed, 1);
  assert.equal(opened.authorizeOperator('jessica'), false, 'without OPERATOR_IDS nobody may act');
  assert.equal((await run({ PERSISTENCE: 'memory' }, ['list'])).exitCode, EXIT_CODES.configurationRejected);
  assert.equal((await run({}, ['release-retry', 'job', '--operator', 'jessica', '--reason', 'x'])).exitCode, EXIT_CODES.configurationRejected);
  assert.match(errors.at(-1), /OPERATOR_IDS does not list operator jessica/);
  assert.equal((await run({ OPERATOR_IDS: 'jessica' }, ['accept', 'issue-1', '--operator', 'jessica', '--reason', 'x'])).exitCode, EXIT_CODES.configurationRejected,
    'accept needs the worker configuration');
  assert.doesNotMatch(errors.join(' '), /TOP_SECRET/);
});
