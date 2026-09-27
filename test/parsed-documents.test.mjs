import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CORE_STAT_FIELDS, assertParsedDocument, decimalMinutes, parsedDocumentError,
} from '../src/contracts/parsed-documents.mjs';
import { blank, present, unavailable } from '../src/contracts/value-state.mjs';
import { boxScoreDocument, gameLogDocument, seasonDocument, statLine } from '../src/application/fixture-documents.mjs';
import { FixtureParser } from '../src/parsers/index.mjs';
import { foundationCorpus } from '../fixtures/foundation-corpus.mjs';

function pageTypeFor(url) {
  const path = new URL(url).pathname;
  if (path === '/cbb/schools/') return 'school_index';
  if (path.startsWith('/box/')) return 'box_score';
  if (path.endsWith('-gamelogs.html')) return 'game_log';
  if (path.endsWith('.html')) return 'season';
  return 'school_history';
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }

const finalBox = () => boxScoreDocument({ status: 'final',
  away: { name: 'B', score: 60, stats: statLine({ pts: 60 }) },
  home: { name: 'A', schoolPath: '/school/a', score: 61, stats: statLine({ pts: 61 }),
    players: [{ name: 'Guard', playerPath: '/players/guard', starter: true, stats: statLine({ minutes: 32.5, pts: 20 }) }] } });

test('every synthetic corpus document satisfies its page-type contract', () => {
  for (const entry of foundationCorpus()) {
    const parsed = new FixtureParser(pageTypeFor(entry.url)).parse({ body: Buffer.from(entry.body) });
    assert.equal(parsed.kind, 'valid', entry.url);
    assert.equal(parsedDocumentError(pageTypeFor(entry.url), parsed.document), null, entry.url);
  }
});

test('stat lines require all sixteen core fields as source values', () => {
  assert.deepEqual(CORE_STAT_FIELDS, ['minutes', 'fg', 'fga', 'fg3', 'fg3a', 'ft', 'fta', 'orb', 'drb', 'trb', 'ast', 'stl', 'blk', 'tov', 'pf', 'pts']);
  const missing = clone(finalBox());
  delete missing.teams[0].stats.tov;
  assert.equal(parsedDocumentError('box_score', missing), 'box_score.teams[0].stats.tov: expected a required field');

  const plainNumber = clone(finalBox());
  plainNumber.teams[0].stats.fg = 20;
  assert.match(parsedDocumentError('box_score', plainNumber), /teams\[0\]\.stats\.fg: expected a source value/);

  const fractional = clone(finalBox());
  fractional.teams[0].stats.fg = present(20.5);
  assert.match(parsedDocumentError('box_score', fractional), /stats\.fg\.value: expected an integer >= 0/);

  const decimalMinutesAllowed = clone(finalBox());
  decimalMinutesAllowed.teams[1].players[0].stats.minutes = present(38.25);
  assert.equal(parsedDocumentError('box_score', decimalMinutesAllowed), null);

  const negativeMinutes = clone(finalBox());
  negativeMinutes.teams[1].players[0].stats.minutes = present(-1);
  assert.match(parsedDocumentError('box_score', negativeMinutes), /minutes\.value: expected decimal minutes >= 0/);
});

test('non-present states stay distinct and extra values hold printed percentages as fractions', () => {
  const box = clone(finalBox());
  box.teams[1].players[0].stats.stl = blank();
  box.teams[1].players[0].stats.blk = unavailable('not_published');
  box.teams[1].players[0].stats.extra = { fg_pct: present(0.333), game_score: present(14.2) };
  box.teams[1].advanced = { efg_pct: present(0.512), note: present('estimated') };
  assert.equal(parsedDocumentError('box_score', box), null);
  box.teams[1].advanced.bad = { state: 'present' };
  assert.match(parsedDocumentError('box_score', box), /teams\[1\]\.advanced\.bad: expected a source value/);
});

test('box scores need exactly one away and one home team and a known status', () => {
  const twoHomes = clone(finalBox());
  twoHomes.teams[0].side = 'home';
  assert.equal(parsedDocumentError('box_score', twoHomes), 'box_score.teams: expected exactly one away team and one home team');
  const status = clone(finalBox());
  status.status = 'postponed';
  assert.match(parsedDocumentError('box_score', status), /box_score\.status: expected one of scheduled, final/);
  const context = clone(finalBox());
  context.context = 'road';
  assert.match(parsedDocumentError('box_score', context), /box_score\.context: expected one of home, away, neutral/);
});

test('game-log rows carry location, linked opponent identity, result, and nullable stat lines', () => {
  const log = gameLogDocument(2024, [
    { location: 'neutral', opponent: { name: 'Houston', schoolPath: '/cbb/schools/houston/men/' }, status: 'final', date: '2024-03-29',
      teamScore: 54, opponentScore: 51, teamStats: statLine({ pts: 54 }), opponentStats: statLine({ pts: 51 }), boxScoreUrl: '/box/1.html' },
    { location: 'away', opponent: { name: 'Central Connecticut State', schoolPath: '/cbb/schools/central-connecticut-state/men/' }, status: 'incomplete' },
  ]);
  assert.equal(parsedDocumentError('game_log', log), null);
  assert.equal(log.games[0].result, 'W');
  assert.equal(log.games[1].teamStats, null);

  const badLocation = clone(log);
  badLocation.games[0].location = 'N';
  assert.match(parsedDocumentError('game_log', badLocation), /games\[0\]\.location: expected one of home, away, neutral, or null/);
  const nameOnly = clone(log);
  delete nameOnly.games[0].opponent.schoolPath;
  assert.equal(parsedDocumentError('game_log', nameOnly), 'game_log.games[0].opponent.schoolPath: expected a required field');
  const badDate = clone(log);
  badDate.games[0].date = '03/29/2024';
  assert.match(parsedDocumentError('game_log', badDate), /date: expected an ISO date/);
});

test('season documents carry summary, tournament seed, roster, totals, and player totals', () => {
  const season = seasonDocument({ school: 'Duke', endingYear: 2024, gameLogUrl: '/cbb/schools/duke/men/2024-gamelogs.html' });
  season.summary.ncaaTournament = { seed: present(4), region: 'South', games: [
    { round: 'First Round', result: 'W', teamScore: 64, opponentScore: 47, opponent: { name: 'Vermont', seed: 13 } },
  ] };
  season.summary.conference = { name: 'ACC', path: '/cbb/conferences/acc/men/2024.html' };
  assert.equal(parsedDocumentError('season', season), null);

  const badSeed = clone(season);
  badSeed.summary.ncaaTournament.games[0].result = 'Won';
  assert.match(parsedDocumentError('season', badSeed), /ncaaTournament\.games\[0\]\.result: expected one of W, L/);
  const noTotals = clone(season);
  noTotals.teamTotals = null;
  assert.equal(parsedDocumentError('season', noTotals), null);
  assert.throws(() => assertParsedDocument('season', { ...season, pace: 70 }), /season\.pace: expected no such field/);
});

test('decimal minutes convert source clock values', () => {
  assert.equal(decimalMinutes('32:30'), 32.5);
  assert.equal(decimalMinutes('0:45'), 0.75);
  assert.equal(decimalMinutes('40:00'), 40);
  assert.throws(() => decimalMinutes('32.5'), /Expected MM:SS/);
  assert.throws(() => decimalMinutes('32:75'), /Expected MM:SS/);
});
