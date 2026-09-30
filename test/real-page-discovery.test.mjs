import test from 'node:test';
import assert from 'node:assert/strict';
import { Discovery } from '../src/discovery/index.mjs';
import { InMemoryPersistence } from '../src/persistence/index.mjs';
import { createSnapshot } from '../src/contracts/boundaries.mjs';
import { createSourceUrl } from '../src/contracts/source.mjs';
import { targetEndingYearsFor } from '../src/contracts/season.mjs';
const TARGET_ENDING_YEARS = targetEndingYearsFor(2026);
import { SPORTS_REFERENCE_HOST, SportsReferenceSourceAdapter } from '../src/application/sports-reference-source-adapter.mjs';
import { gameLogDocument, schoolHistoryDocument, seasonDocument } from '../src/application/fixture-documents.mjs';
import {
  captureChecksum, captureLinkDocument, captureManifest, captureSkip, captureSnapshot,
} from '../fixtures/sports-reference/captures.mjs';

// Discovery for all five stages against the real Sports Reference captures
// (#37). The captures are gitignored, so these tests skip when they are absent;
// the synthetic tests at the end cover the same rules without them.

const discovery = new Discovery({
  providerId: 'sports-reference', allowedHosts: [SPORTS_REFERENCE_HOST], targetEndingYears: TARGET_ENDING_YEARS,
  sourceAdapter: new SportsReferenceSourceAdapter(),
});
const school = (slug) => `sports-reference:www.sports-reference.com/cbb/schools/${slug}/men`;
const absolute = (path) => `https://www.sports-reference.com${path}`;
const rejected = (result) => result.observations.filter((entry) => entry.kind === 'rejected_url');

function discoverCapture(pageType, sitePath, schoolSourcePath) {
  const snapshot = captureSnapshot(sitePath, { jobKey: `sports-reference:www.sports-reference.com${sitePath}:${pageType}`, schoolSourcePath });
  return discovery.discover(pageType, snapshot, captureLinkDocument(pageType, sitePath));
}

function discoverDocument(pageType, sitePath, document, schoolSourcePath) {
  const sourceUrl = createSourceUrl('sports-reference', absolute(sitePath));
  const snapshot = createSnapshot({
    jobKey: `${sitePath}:${pageType}`, schoolSourcePath, sourceUrl, body: Buffer.from('{}'),
    sourceUrlFrom: (target, baseUrl = sourceUrl.absoluteUrl) => createSourceUrl('sports-reference', target, baseUrl),
  });
  return discovery.discover(pageType, snapshot, document);
}

test('local real captures match the committed manifest', { skip: captureSkip(...Object.keys(captureManifest)) }, () => {
  for (const [sitePath, entry] of Object.entries(captureManifest)) assert.equal(captureChecksum(sitePath), entry.sha256, sitePath);
});

test('stage 1: the real school index queues a history page only for To == 2026 schools', { skip: captureSkip('/cbb/schools/') }, () => {
  const { schools } = captureLinkDocument('school_index', '/cbb/schools/');
  const result = discoverCapture('school_index', '/cbb/schools/');
  const eligible = schools.filter((entry) => entry.to === 2026);
  assert.ok(eligible.length > 300 && eligible.length < schools.length, `eligible ${eligible.length} of ${schools.length}`);
  assert.equal(result.childJobs.length, eligible.length);
  assert.ok(result.childJobs.every((job) => job.pageType === 'school_history'));
  assert.deepEqual(result.childJobs.map((job) => job.sourceUrl.absoluteUrl), eligible.map((entry) => entry.historyUrl));
  const observed = result.observations.filter((entry) => entry.kind === 'school');
  assert.equal(observed.length, schools.length);
  assert.equal(observed.filter((entry) => entry.eligible).length, eligible.length);
  const duke = result.childJobs.find((job) => job.sourceUrl.absoluteUrl === absolute('/cbb/schools/duke/men/'));
  assert.equal(duke.schoolSourcePath, school('duke'));
  assert.ok(result.childJobs.some((job) => job.schoolSourcePath === school('le-moyne')));
  const former = schools.find((entry) => entry.to !== 2026 && entry.historyUrl);
  assert.ok(former, 'the index lists at least one school that left Division I');
  assert.equal(result.childJobs.some((job) => job.sourceUrl.absoluteUrl === former.historyUrl), false);
  assert.deepEqual(rejected(result), []);
});

test('stage 2: real history pages queue linked 2022-2026 seasons and mark missing ones unavailable', { skip: captureSkip('/cbb/schools/duke/men/', '/cbb/schools/le-moyne/men/') }, () => {
  const duke = discoverCapture('school_history', '/cbb/schools/duke/men/', school('duke'));
  assert.deepEqual(duke.childJobs.map((job) => job.sourceUrl.absoluteUrl),
    [2026, 2025, 2024, 2023, 2022].map((year) => absolute(`/cbb/schools/duke/men/${year}.html`)));
  assert.ok(duke.childJobs.every((job) => job.pageType === 'season' && job.schoolSourcePath === school('duke')));
  assert.deepEqual(duke.unavailableCoverage, []);

  // Le Moyne joined Division I for 2024: 2022 and 2023 are gaps, not failures.
  const leMoyne = discoverCapture('school_history', '/cbb/schools/le-moyne/men/', school('le-moyne'));
  assert.deepEqual(leMoyne.childJobs.map((job) => job.sourceUrl.absoluteUrl),
    [2026, 2025, 2024].map((year) => absolute(`/cbb/schools/le-moyne/men/${year}.html`)));
  assert.deepEqual(leMoyne.unavailableCoverage, [
    { schoolSourcePath: school('le-moyne'), endingYear: 2022, reason: 'not_linked' },
    { schoolSourcePath: school('le-moyne'), endingYear: 2023, reason: 'not_linked' },
  ]);
  assert.deepEqual([...rejected(duke), ...rejected(leMoyne)], []);
});

test('stage 3: real season pages queue the published game-log link', { skip: captureSkip('/cbb/schools/duke/men/2024.html', '/cbb/schools/le-moyne/men/2024.html') }, () => {
  for (const slug of ['duke', 'le-moyne']) {
    const result = discoverCapture('season', `/cbb/schools/${slug}/men/2024.html`, school(slug));
    assert.deepEqual(result.childJobs.map((job) => [job.pageType, job.sourceUrl.absoluteUrl, job.schoolSourcePath]),
      [['game_log', absolute(`/cbb/schools/${slug}/men/2024-gamelogs.html`), school(slug)]]);
    assert.deepEqual(result.warnings, []);
  }
});

test('stage 4: a real game log observes every row and queues only published box-score links', { skip: captureSkip('/cbb/schools/le-moyne/men/2024-gamelogs.html', '/cbb/schools/duke/men/2024-gamelogs.html') }, () => {
  const result = discoverCapture('game_log', '/cbb/schools/le-moyne/men/2024-gamelogs.html', school('le-moyne'));
  const rows = result.observations.filter((entry) => entry.kind === 'game_log');
  assert.equal(rows.length, 33);
  assert.deepEqual(rows.map((entry) => entry.rowIndex), [...rows.keys()]);
  assert.equal(result.childJobs.length, 32);
  assert.ok(result.childJobs.every((job) => job.pageType === 'box_score' && job.schoolSourcePath === school('le-moyne')));
  assert.ok(result.childJobs.every((job) => /^\/cbb\/boxscores\/[^/]+\.html$/.test(job.sourceUrl.path)));

  // The incomplete 2024-01-20 row has no box-score link: observed, never queued.
  const incomplete = rows.find((entry) => entry.game.date === '2024-01-20');
  assert.equal(incomplete.game.status, 'incomplete');
  assert.equal(incomplete.canonicalBoxScorePath, null);
  assert.equal(incomplete.opponentSchoolSourcePath, school('central-connecticut-state'));

  // An unlinked (non-D-I) opponent has no identity; its box score is still queued.
  const canton = rows.find((entry) => entry.game.opponent.name === 'SUNY Canton');
  assert.equal(canton.opponentSchoolSourcePath, null);
  assert.equal(canton.canonicalBoxScorePath, 'sports-reference:www.sports-reference.com/cbb/boxscores/2023-11-13-19-le-moyne.html');
  assert.ok(result.childJobs.some((job) => job.sourceUrl.absoluteUrl === absolute('/cbb/boxscores/2023-11-13-19-le-moyne.html')));

  // Linked opponents are identified by school path and never crawled.
  assert.equal(rows.find((entry) => entry.game.opponent.name === 'Georgetown').opponentSchoolSourcePath, school('georgetown'));
  assert.equal(result.childJobs.some((job) => job.sourceUrl.path.startsWith('/cbb/schools/')), false);
  assert.deepEqual(rejected(result), []);

  const duke = discoverCapture('game_log', '/cbb/schools/duke/men/2024-gamelogs.html', school('duke'));
  const dukeRows = duke.observations.filter((entry) => entry.kind === 'game_log');
  assert.equal(dukeRows.length, 36);
  assert.equal(duke.childJobs.length, 36);
  assert.deepEqual([...new Set(dukeRows.map((entry) => entry.game.location))].sort(), ['away', 'home', 'neutral']);
  const houston = dukeRows.find((entry) => entry.game.boxScoreUrl === absolute('/cbb/boxscores/2024-03-29-21-houston.html'));
  assert.equal(houston.game.location, 'neutral');
  assert.equal(houston.opponentSchoolSourcePath, school('houston'));
  assert.deepEqual(rejected(duke), []);
});

test('stage 5: real box scores identify both teams and queue nothing', { skip: captureSkip('/cbb/boxscores/2023-11-13-19-le-moyne.html', '/cbb/boxscores/2024-01-27-16-duke.html', '/cbb/boxscores/2024-02-03-18-north-carolina.html', '/cbb/boxscores/2024-03-29-21-houston.html', '/cbb/boxscores/2024-02-15-19-le-moyne.html') }, () => {
  const expected = {
    '/cbb/boxscores/2023-11-13-19-le-moyne.html': [null, school('le-moyne')],
    '/cbb/boxscores/2024-01-27-16-duke.html': [school('clemson'), school('duke')],
    '/cbb/boxscores/2024-02-03-18-north-carolina.html': [school('duke'), school('north-carolina')],
    '/cbb/boxscores/2024-03-29-21-houston.html': [school('duke'), school('houston')],
    '/cbb/boxscores/2024-02-15-19-le-moyne.html': [school('central-connecticut-state'), school('le-moyne')],
  };
  for (const [sitePath, [away, home]] of Object.entries(expected)) {
    const result = discoverCapture('box_score', sitePath);
    // Prev/next game and team links on the page are not followed.
    assert.deepEqual(result.childJobs, [], sitePath);
    const [observation] = result.observations;
    assert.equal(observation.kind, 'box_score');
    assert.deepEqual(observation.teams.map((team) => [team.side, team.schoolSourcePath]), [['away', away], ['home', home]], sitePath);
  }
});

test('a box score linked from both teams\' game logs is one job', { skip: captureSkip('/cbb/schools/duke/men/2024-gamelogs.html') }, () => {
  const fromDuke = discoverCapture('game_log', '/cbb/schools/duke/men/2024-gamelogs.html', school('duke'));
  const shared = fromDuke.childJobs.find((job) => job.sourceUrl.absoluteUrl === absolute('/cbb/boxscores/2024-02-03-18-north-carolina.html'));
  // The North Carolina log publishes the same box score, as a relative link.
  const fromCarolina = discoverDocument('game_log', '/cbb/schools/north-carolina/men/2024-gamelogs.html', gameLogDocument(2024, [{
    status: 'scheduled', location: 'home', opponent: { name: 'Duke', schoolPath: '/cbb/schools/duke/men/2024.html' },
    boxScoreUrl: '/cbb/boxscores/2024-02-03-18-north-carolina.html',
  }]), school('north-carolina'));
  assert.equal(fromCarolina.childJobs[0].key, shared.key);
  const persistence = new InMemoryPersistence();
  persistence.addJob(fromDuke.childJobs.find((job) => job.key === shared.key));
  persistence.addJob(fromCarolina.childJobs[0]);
  assert.equal(persistence.listJobs().filter((job) => job.pageType === 'box_score').length, 1);
});

test('discovery refuses robots.txt-disallowed and mistyped links without queueing them', () => {
  const log = discoverDocument('game_log', '/cbb/schools/duke/men/2024-gamelogs.html', gameLogDocument(2024, [
    { status: 'scheduled', opponent: { name: 'A', schoolPath: null }, boxScoreUrl: '/cbb/boxscores/index.cgi?month=1&day=20&year=2024' },
    { status: 'scheduled', opponent: { name: 'B', schoolPath: null }, boxScoreUrl: '/cbb/schools/duke/men/2024.html' },
    { status: 'scheduled', opponent: { name: 'C', schoolPath: '/cbb/req/202602162/tlogo.png' }, boxScoreUrl: null },
  ]), school('duke'));
  assert.deepEqual(log.childJobs, []);
  const rows = log.observations.filter((entry) => entry.kind === 'game_log');
  assert.deepEqual(rows.map((entry) => entry.canonicalBoxScorePath), [null, null, null]);
  assert.equal(rows[2].opponentSchoolSourcePath, null);
  assert.deepEqual(rejected(log).map((entry) => entry.reason.match(/robots\.txt disallows|is not a box score page|not a school history/)?.[0]),
    ['robots.txt disallows', 'is not a box score page', 'robots.txt disallows']);

  const history = discoverDocument('school_history', '/cbb/schools/duke/men/', schoolHistoryDocument([
    { endingYear: 2026, url: '/cbb/schools/duke/men/2026.html' },
    { endingYear: 2025, url: '/cbb/schools/duke/men/2025-gamelogs.html' },
    { endingYear: 2024, url: null },
    { endingYear: 2021, url: '/cbb/schools/duke/men/2021.html' },
  ]), school('duke'));
  assert.deepEqual(history.childJobs.map((job) => job.sourceUrl.path), ['/cbb/schools/duke/men/2026.html']);
  assert.deepEqual(history.unavailableCoverage.map((entry) => [entry.endingYear, entry.reason]),
    [[2022, 'not_linked'], [2023, 'not_linked'], [2024, 'not_linked'], [2025, 'link_rejected']]);

  const season = discoverDocument('season', '/cbb/schools/duke/men/2024.html',
    seasonDocument({ school: 'Duke', endingYear: 2024, gameLogUrl: null }), school('duke'));
  assert.deepEqual(season.childJobs, []);
  assert.match(season.warnings[0], /publishes no game-log link/);
});
