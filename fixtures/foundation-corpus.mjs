// Synthetic, provider-neutral raw HTML snapshots. The embedded document follows
// the frozen parsed-document contracts; it is not a selector or a claim about a
// real provider. Each game's stat lines are defined once, and the game logs, box
// scores and season totals are derived from them so reconciliation holds.
import { blank, explicitNull, present } from '../src/contracts/value-state.mjs';
import {
  boxScoreDocument, gameLogDocument, schoolHistoryDocument, schoolIndexDocument, seasonDocument, statLine,
} from '../src/application/fixture-documents.mjs';

const origin = 'https://fixture.example';

function html(document) {
  const payload = JSON.stringify(document).replaceAll('<', '\\u003c');
  return `<!doctype html><html><body><script id="fixture-document" type="application/json">${payload}</script></body></html>`;
}

function entry(path, document) { return { url: `${origin}${path}`, body: html(document) }; }

const schoolA = { name: 'Fixture A', schoolPath: '/school/a' };
const schoolB = { name: 'Fixture B', schoolPath: '/school/b' };
const aGuard = { name: 'Fixture A Guard', playerPath: '/players/a-guard' };
const bForward = { name: 'Fixture B Forward', playerPath: '/players/b-forward' };

const one = {
  a: statLine({ minutes: 200, fg: 26, fga: 60, fg3: 6, fg3a: 20, ft: 12, fta: 16, orb: 10, drb: 25, trb: 35, ast: 14, stl: 6, blk: 3, tov: 11, pf: 17, pts: 70 }),
  b: statLine({ minutes: 200, fg: 24, fga: 58, fg3: 7, fg3a: 22, ft: 10, fta: 14, orb: 8, drb: 24, trb: 32, ast: 12, stl: 5, blk: 2, tov: 13, pf: 18, pts: 65 }),
  // Numeric zero, explicit null, and blank stay distinct from each other.
  aGuard: statLine({ minutes: 32.5, fg: 7, fga: 15, fg3: 2, fg3a: 6, ft: 4, fta: 5, orb: 1, drb: 4, trb: 5, ast: 6, stl: explicitNull(), blk: present(0), tov: 2, pf: 3, pts: 20 }),
  aReserve: statLine(Object.fromEntries(['minutes', 'fg', 'fga', 'fg3', 'fg3a', 'ft', 'fta', 'orb', 'drb', 'trb', 'ast', 'stl', 'blk', 'tov', 'pf', 'pts'].map((field) => [field, blank()]))),
  bForward: statLine({ minutes: 30, fg: 8, fga: 14, fg3: 1, fg3a: 3, ft: 3, fta: 4, orb: 3, drb: 7, trb: 10, ast: 2, stl: 1, blk: 2, tov: 1, pf: 4, pts: 20 }),
};
const four = {
  a: statLine({ minutes: 250, fg: 28, fga: 70, fg3: 9, fg3a: 27, ft: 13, fta: 18, orb: 12, drb: 30, trb: 42, ast: 15, stl: 7, blk: 4, tov: 14, pf: 22, pts: 78 }),
  b: statLine({ minutes: 250, fg: 29, fga: 66, fg3: 8, fg3a: 21, ft: 14, fta: 19, orb: 11, drb: 31, trb: 42, ast: 16, stl: 8, blk: 5, tov: 12, pf: 20, pts: 80 }),
  bForward: statLine({ minutes: 38.25, fg: 10, fga: 19, fg3: 2, fg3a: 5, ft: 5, fta: 6, orb: 4, drb: 9, trb: 13, ast: 3, stl: 2, blk: 1, tov: 2, pf: 3, pts: 27 }),
};

export function foundationCorpus({ faults = false } = {}) {
  const aLog = [
    { location: 'home', opponent: schoolB, boxScoreUrl: '/box/one.html', status: 'final', date: '2026-01-02',
      teamScore: 70, opponentScore: 65, teamStats: one.a, opponentStats: one.b },
    { location: 'home', opponent: schoolB, boxScoreUrl: '/box/two.html', status: 'canceled', date: '2026-01-03' },
    { location: 'away', opponent: { name: 'Unlinked Opponent', schoolPath: null }, status: 'scheduled' },
  ];
  if (faults) aLog.push({ location: 'away', opponent: { name: 'Outside', schoolPath: null }, boxScoreUrl: 'https://outside.example/box/unsafe.html', status: 'scheduled' });
  const bLog = [
    { location: 'away', opponent: schoolA, boxScoreUrl: '/box/one.html', status: 'final', date: '2026-01-02',
      teamScore: 65, opponentScore: 70, teamStats: one.b, opponentStats: one.a },
    { location: 'home', opponent: schoolA, boxScoreUrl: '/box/three.html', status: 'rescheduled', date: '2026-01-04' },
    { location: 'neutral', opponent: schoolA, boxScoreUrl: '/box/four.html', status: 'final', date: '2026-01-05', overtimes: 2,
      teamScore: 80, opponentScore: 78, teamStats: four.b, opponentStats: four.a },
    { location: 'home', opponent: schoolA, boxScoreUrl: '/box/six.html', status: 'scheduled', date: '2026-02-01' },
  ];
  if (faults) bLog.push({ location: 'home', opponent: { name: 'Shifted', schoolPath: null }, boxScoreUrl: '/box/shift.html', status: 'scheduled' });
  const a2024Log = [{ location: 'away', opponent: schoolB, boxScoreUrl: '/box/five.html', status: 'incomplete', date: '2024-02-01' }];

  return [
    entry('/cbb/schools/', schoolIndexDocument([
      { path: '/school/a', name: 'Fixture A', to: 2026, historyUrl: '/school/a/men/' },
      { path: '/school/b', name: 'Fixture B', to: 2026, historyUrl: '/school/b/men/' },
      { path: '/school/c', name: 'Fixture C', to: 2025, historyUrl: '/school/c/men/' },
    ])),
    entry('/school/a/men/', schoolHistoryDocument([
      { endingYear: 2026, url: '/school/a/men/2026.html' },
      { endingYear: 2024, url: '/school/a/men/2024.html' },
    ])),
    entry('/school/b/men/', schoolHistoryDocument([{ endingYear: 2026, url: '/school/b/men/2026.html' }])),
    entry('/school/a/men/2026.html', seasonDocument({ school: 'Fixture A', endingYear: 2026, gameLogUrl: '/school/a/men/2026-gamelogs.html',
      games: aLog, players: [{ ...aGuard, lines: [one.aGuard] }] })),
    entry('/school/a/men/2024.html', seasonDocument({ school: 'Fixture A', endingYear: 2024, gameLogUrl: '/school/a/men/2024-gamelogs.html', games: a2024Log })),
    entry('/school/b/men/2026.html', seasonDocument({ school: 'Fixture B', endingYear: 2026, gameLogUrl: '/school/b/men/2026-gamelogs.html',
      games: bLog, players: [{ ...bForward, lines: [one.bForward, four.bForward] }] })),
    entry('/school/a/men/2026-gamelogs.html', gameLogDocument(2026, aLog)),
    entry('/school/a/men/2024-gamelogs.html', gameLogDocument(2024, a2024Log)),
    entry('/school/b/men/2026-gamelogs.html', gameLogDocument(2026, bLog)),
    entry('/box/one.html', boxScoreDocument({ date: '2026-01-02', status: 'final',
      away: { ...schoolB, score: 65, stats: one.b, players: [{ ...bForward, starter: true, stats: one.bForward }] },
      home: { ...schoolA, score: 70, stats: one.a, players: [
        { ...aGuard, starter: true, stats: one.aGuard },
        { name: 'Fixture A Reserve', playerPath: null, starter: false, stats: one.aReserve },
      ] } })),
    entry('/box/two.html', boxScoreDocument({ date: '2026-01-03', status: 'canceled', away: schoolB, home: schoolA })),
    entry('/box/three.html', boxScoreDocument({ date: '2026-01-04', status: 'rescheduled', away: schoolA, home: schoolB })),
    entry('/box/four.html', boxScoreDocument({ date: '2026-01-05', status: 'final', overtimes: 2,
      away: { ...schoolA, score: 78, stats: four.a },
      home: { ...schoolB, score: 80, stats: four.b, players: [{ ...bForward, starter: true, stats: four.bForward }] } })),
    entry('/box/five.html', boxScoreDocument({ date: '2024-02-01', status: 'incomplete', away: schoolA, home: schoolB })),
    entry('/box/six.html', boxScoreDocument({ date: '2026-02-01', status: 'scheduled', away: schoolA, home: schoolB })),
    ...(faults ? [entry('/box/shift.html', { layoutShift: true })] : []),
  ];
}
