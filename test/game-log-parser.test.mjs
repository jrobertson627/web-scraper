import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { IngestionOrchestrator } from '../src/application/orchestrator.mjs';
import { createJob, createSnapshot } from '../src/contracts/boundaries.mjs';
import { CORE_STAT_FIELDS } from '../src/contracts/parsed-documents.mjs';
import { canonicalizeSourceUrl, createSourceUrl } from '../src/contracts/source.mjs';
import { MemoryRawStore, InMemoryPersistence } from '../src/persistence/index.mjs';
import { GameLogParser, createProductionParserRegistry } from '../src/parsers/index.mjs';
import { captureSkip, captureSnapshot } from '../fixtures/sports-reference/captures.mjs';

const origin = 'https://www.sports-reference.com';
const dukeLog = '/cbb/schools/duke/men/2024-gamelogs.html';
const leMoyneLog = '/cbb/schools/le-moyne/men/2024-gamelogs.html';
const sideStats = ['fg', 'fga', 'fg_pct', 'fg3', 'fg3a', 'fg3_pct', 'fg2', 'fg2a', 'fg2_pct', 'efg_pct', 'ft', 'fta', 'ft_pct',
  'orb', 'drb', 'trb', 'ast', 'stl', 'blk', 'tov', 'pf'];
const columns = ['ranker', 'team_game_num_season', 'date', 'game_location', 'opp_name_abbr', 'game_type', 'team_game_result',
  'team_game_score', 'opp_team_game_score', 'overtimes', ...sideStats, ...sideStats.map((stat) => `opp_${stat}`)];
const blankLine = Object.fromEntries(sideStats.flatMap((stat) => [[stat, ''], [`opp_${stat}`, '']]));
const playedLine = {
  fg: '30', fga: '60', fg_pct: '.500', fg3: '5', fg3a: '15', fg3_pct: '.333', fg2: '25', fg2a: '45', fg2_pct: '.556',
  efg_pct: '.542', ft: '10', fta: '12', ft_pct: '.833', orb: '8', drb: '24', trb: '32', ast: '15', stl: '6', blk: '0', tov: '9', pf: '14',
  opp_fg: '25', opp_fga: '58', opp_fg_pct: '.431', opp_fg3: '6', opp_fg3a: '20', opp_fg3_pct: '.300', opp_fg2: '19', opp_fg2a: '38',
  opp_fg2_pct: '.500', opp_efg_pct: '.483', opp_ft: '4', opp_fta: '6', opp_ft_pct: '.667', opp_orb: '7', opp_drb: '20', opp_trb: '27',
  opp_ast: '11', opp_stl: '4', opp_blk: '2', opp_tov: '12', opp_pf: '15',
};

function snapshot(path, body) {
  const sourceUrl = createSourceUrl('sports-reference', `${origin}${path}`);
  return createSnapshot({
    jobKey: `test:${path}`, sourceUrl, body: Buffer.from(body),
    sourceUrlFrom: (target, baseUrl = sourceUrl.absoluteUrl) => createSourceUrl('sports-reference', target, baseUrl),
  });
}

function row(values) {
  const cells = columns.map((stat) => `<td data-stat="${stat}">${values[stat] ?? ''}</td>`).join('');
  return `<tr>${cells}</tr>`;
}

function gameLogHtml(rows) {
  const headers = columns.map((stat) => `<th data-stat="${stat}">${stat}</th>`).join('');
  const repeated = `<tr class="thead">${headers}</tr>`;
  return `<table id="team_game_log"><thead><tr>${headers}</tr></thead><tbody>${rows.map(row).join(repeated)}</tbody></table>`;
}

const played = (values) => ({ ...playedLine, team_game_result: 'W', team_game_score: '75', opp_team_game_score: '67', ...values });
const parse = (html, path = dukeLog) => createProductionParserRegistry().parse('game_log', '1', snapshot(path, html));

test('game_log@1 emits the frozen row shape with stat lines, derived school path and absolute box-score link', () => {
  const parsed = parse(gameLogHtml([played({
    ranker: '1', team_game_num_season: '1', date: '<a href="/cbb/boxscores/2023-11-06-21-duke.html">2023-11-06</a>',
    opp_name_abbr: '<a href="/cbb/schools/dartmouth/men/2024.html">Dartmouth</a>', game_type: 'REG (Non-Conf)',
  })]));
  assert.equal(parsed.kind, 'valid');
  const count = (value) => ({ state: 'present', value });
  const line = (prefix, points) => ({
    minutes: { state: 'unavailable', reason: 'not_published' },
    ...Object.fromEntries(CORE_STAT_FIELDS.slice(1, -1).map((field) => [field, count(Number(playedLine[`${prefix}${field}`]))])),
    pts: count(points),
    extra: Object.fromEntries(['fg_pct', 'fg3_pct', 'fg2', 'fg2a', 'fg2_pct', 'efg_pct', 'ft_pct']
      .map((stat) => [stat, count(Number(playedLine[`${prefix}${stat}`]))])),
  });
  assert.deepEqual(parsed.document, {
    endingYear: 2024,
    games: [{
      gameNumber: 1, date: '2023-11-06', location: 'home',
      opponent: { name: 'Dartmouth', schoolPath: '/cbb/schools/dartmouth/men/' },
      gameType: 'REG (Non-Conf)', result: 'W', status: 'final', overtimes: 0,
      teamScore: count(75), opponentScore: count(67), teamStats: line('', 75), opponentStats: line('opp_', 67),
      boxScoreUrl: `${origin}/cbb/boxscores/2023-11-06-21-duke.html`,
    }],
  });
  // A printed zero is a present zero, never blank.
  assert.deepEqual(parsed.document.games[0].teamStats.blk, count(0));
});

test('game_log@1 reads away, neutral and overtime rows and skips repeated header rows', () => {
  const parsed = parse(gameLogHtml([
    played({ team_game_num_season: '1', date: '2023-11-06', game_location: '@', overtimes: 'OT' }),
    played({ team_game_num_season: '2', date: '2023-11-10', game_location: 'N', overtimes: '2OT', team_game_result: 'L', team_game_score: '80', opp_team_game_score: '84' }),
    played({ team_game_num_season: '3', date: '2023-11-14' }),
  ]));
  assert.equal(parsed.kind, 'valid');
  assert.deepEqual(parsed.document.games.map((game) => [game.gameNumber, game.location, game.result, game.overtimes]),
    [[1, 'away', 'W', 1], [2, 'neutral', 'L', 2], [3, 'home', 'W', 0]]);
});

test('game_log@1 keeps an unlinked opponent and an unplayed row without inventing identity, links or zeros', () => {
  const parsed = parse(gameLogHtml([
    played({ team_game_num_season: '1', date: '<a href="/cbb/boxscores/2023-11-13-19-le-moyne.html">2023-11-13</a>', opp_name_abbr: 'SUNY Canton' }),
    { ranker: '2', date: '2024-01-20', game_location: '@', game_type: 'REG (Conf)', ...blankLine,
      opp_name_abbr: '<a href="/cbb/schools/central-connecticut-state/men/2024.html">Central Connecticut State</a>' },
  ]), leMoyneLog);
  assert.equal(parsed.kind, 'valid');
  const [canton, unplayed] = parsed.document.games;
  assert.deepEqual(canton.opponent, { name: 'SUNY Canton', schoolPath: null });
  assert.equal(canton.boxScoreUrl, `${origin}/cbb/boxscores/2023-11-13-19-le-moyne.html`);
  assert.deepEqual({ ...unplayed, teamStats: undefined, opponentStats: undefined }, {
    gameNumber: null, date: '2024-01-20', location: 'away',
    opponent: { name: 'Central Connecticut State', schoolPath: '/cbb/schools/central-connecticut-state/men/' },
    gameType: 'REG (Conf)', result: null, status: 'incomplete', overtimes: null,
    teamScore: { state: 'blank' }, opponentScore: { state: 'blank' }, teamStats: undefined, opponentStats: undefined, boxScoreUrl: null,
  });
  // The row prints blank stat cells: every value stays blank, and minutes (never printed) stay unavailable.
  for (const line of [unplayed.teamStats, unplayed.opponentStats]) {
    assert.deepEqual(line.minutes, { state: 'unavailable', reason: 'not_published' });
    for (const field of CORE_STAT_FIELDS.slice(1)) assert.deepEqual(line[field], { state: 'blank' }, field);
    assert.ok(Object.values(line.extra).every((value) => value.state === 'blank'));
  }
});

test('game_log@1 fails closed on row values whose meaning is uncertain', () => {
  const cases = [
    [played({ game_location: 'H' }), /location marker is unexpected: H/],
    [played({ team_game_result: 'T' }), /result is unexpected: T/],
    [played({ team_game_result: '' }), /result and scores disagree/],
    [played({ overtimes: 'SO' }), /overtime marker is unexpected: SO/],
    [played({ date: 'Nov 6, 2023' }), /date is not YYYY-MM-DD/],
    [played({ date: '<a href="/cbb/schools/duke/men/2024.html">2023-11-06</a>' }), /date links to an unexpected page/],
    [played({ opp_name_abbr: '<a href="/cbb/schools/dartmouth/men/">Dartmouth</a>' }), /opponent links to an unexpected page/],
    [played({ fg: '3.5' }), /fg is not a whole number/],
  ];
  for (const [values, expected] of cases) {
    const parsed = parse(gameLogHtml([values]));
    assert.equal(parsed.kind, 'structural_failure');
    assert.match(parsed.error, expected);
  }
  const wrongPath = parse(gameLogHtml([played({})]), '/cbb/schools/duke/men/2024.html');
  assert.match(wrongPath.error, /game log source path is unexpected/);
});

test('game_log@1 fails closed on the layout-shift fixture', () => {
  const parser = new GameLogParser();
  const body = readFileSync(new URL('fixtures/sports-reference/game-log-layout-shift.html', import.meta.url));
  const parsed = parser.parse(snapshot(dukeLog, body));
  assert.equal(parser.version(), '1');
  assert.equal(parsed.kind, 'structural_failure');
  assert.match(parsed.error, /team_game_score column/);
});

test('a game-log layout shift is persisted as parse_failed with parser version and failure details', async () => {
  const now = new Date('2026-09-27T00:00:00Z');
  const clock = () => now;
  const rawStore = new MemoryRawStore();
  const raw = rawStore.put(readFileSync(new URL('fixtures/sports-reference/game-log-layout-shift.html', import.meta.url)));
  const persistence = new InMemoryPersistence(clock);
  const sourceUrl = createSourceUrl('sports-reference', `${origin}${dukeLog}`);
  persistence.addJob(createJob({
    key: 'shifted-game-log', pageType: 'game_log', sourceUrl, canonicalPath: canonicalizeSourceUrl(sourceUrl), parserVersion: '1',
  }));
  const orchestrator = new IngestionOrchestrator({
    fetcher: { fetch: async () => ({ kind: 'fetched', sourceFetchId: 'fetch-shifted-log', checksum: raw.checksum }) },
    parsers: createProductionParserRegistry(), persistence, rawStore, clock,
  });
  const result = await orchestrator.runOnce('parser-test');
  assert.equal(result.events[0].kind, 'parse_failed');
  assert.equal(persistence.getJob('shifted-game-log').state, 'parse_failed');
  assert.deepEqual(persistence.parseRuns.map(({ parserName, parserVersion, status }) => ({ parserName, parserVersion, status })), [
    { parserName: 'game_log', parserVersion: '1', status: 'structural_failure' },
  ]);
  assert.match(persistence.parseRuns[0].failureDetails.error, /team_game_score column/);
});

// Sum of final rows for one side, compared with the page's own season totals row.
function totals(games, side) {
  const finals = games.filter((game) => game.status === 'final');
  return Object.fromEntries(['pts', 'fg', 'fga', 'fg3', 'ft', 'trb', 'ast', 'tov', 'pf']
    .map((field) => [field, finals.reduce((total, game) => total + game[side][field].value, 0)]));
}

test('the real Duke 2024 game log parses home, away and neutral rows with season-page opponent links', { skip: captureSkip(dukeLog) }, () => {
  const parsed = createProductionParserRegistry().parse('game_log', '1', captureSnapshot(dukeLog));
  assert.equal(parsed.kind, 'valid');
  const { endingYear, games } = parsed.document;
  assert.equal(endingYear, 2024);
  assert.equal(games.length, 36);
  assert.deepEqual(games.map((game) => game.gameNumber), games.map((_, index) => index + 1));
  assert.deepEqual(['home', 'away', 'neutral'].map((location) => games.filter((game) => game.location === location).length), [18, 11, 7]);
  assert.ok(games.every((game) => game.status === 'final' && game.overtimes === 0 && game.boxScoreUrl.startsWith(`${origin}/cbb/boxscores/`)));
  assert.deepEqual(games.filter((game) => game.result === 'W').length, 27);
  const houston = games.find((game) => game.date === '2024-03-29');
  assert.deepEqual({ location: houston.location, opponent: houston.opponent, gameType: houston.gameType, result: houston.result,
    teamScore: houston.teamScore, opponentScore: houston.opponentScore, boxScoreUrl: houston.boxScoreUrl }, {
    location: 'neutral', opponent: { name: 'Houston', schoolPath: '/cbb/schools/houston/men/' }, gameType: 'ROUND-16', result: 'W',
    teamScore: { state: 'present', value: 54 }, opponentScore: { state: 'present', value: 51 },
    boxScoreUrl: `${origin}/cbb/boxscores/2024-03-29-21-houston.html`,
  });
  const carolina = games.find((game) => game.boxScoreUrl === `${origin}/cbb/boxscores/2024-02-03-18-north-carolina.html`);
  assert.deepEqual([carolina.location, carolina.opponent.schoolPath], ['away', '/cbb/schools/north-carolina/men/']);
  assert.equal(games.find((game) => game.date === '2024-01-27').location, 'home');
  assert.deepEqual(totals(games, 'teamStats'), { pts: 2830, fg: 1004, fga: 2112, fg3: 298, ft: 524, trb: 1211, ast: 551, tov: 336, pf: 571 });
});

test('the real Le Moyne 2024 game log keeps unlinked opponents, overtime and the incomplete 2024-01-20 row', { skip: captureSkip(leMoyneLog) }, () => {
  const parsed = createProductionParserRegistry().parse('game_log', '1', captureSnapshot(leMoyneLog));
  assert.equal(parsed.kind, 'valid');
  const { games } = parsed.document;
  assert.equal(games.length, 33);
  assert.deepEqual(games.filter((game) => game.opponent.schoolPath === null).map((game) => game.opponent.name),
    ['SUNY Canton', 'Fredonia St.', 'Houghton']);
  const canton = games.find((game) => game.opponent.name === 'SUNY Canton');
  assert.deepEqual([canton.location, canton.result, canton.boxScoreUrl], ['home', 'W', `${origin}/cbb/boxscores/2023-11-13-19-le-moyne.html`]);

  const incomplete = games.filter((game) => game.status === 'incomplete');
  assert.equal(incomplete.length, 1);
  assert.deepEqual({ ...incomplete[0], teamStats: undefined, opponentStats: undefined }, {
    gameNumber: null, date: '2024-01-20', location: 'away',
    opponent: { name: 'Central Connecticut State', schoolPath: '/cbb/schools/central-connecticut-state/men/' },
    gameType: 'REG (Conf)', result: null, status: 'incomplete', overtimes: null,
    teamScore: { state: 'blank' }, opponentScore: { state: 'blank' }, teamStats: undefined, opponentStats: undefined, boxScoreUrl: null,
  });
  assert.deepEqual(incomplete[0].teamStats.fg, { state: 'blank' });

  const overtime = games.find((game) => game.boxScoreUrl === `${origin}/cbb/boxscores/2024-02-15-19-le-moyne.html`);
  assert.deepEqual([overtime.location, overtime.result, overtime.overtimes, overtime.teamScore.value, overtime.opponentScore.value],
    ['home', 'W', 1, 69, 64]);
  assert.deepEqual(games.filter((game) => game.overtimes > 0).length, 1);
  assert.equal(games.filter((game) => game.boxScoreUrl).length, 32);
  assert.deepEqual([games.filter((game) => game.result === 'W').length, games.filter((game) => game.result === 'L').length], [15, 17]);
  assert.deepEqual(totals(games, 'teamStats'), { pts: 2318, fg: 823, fga: 1906, fg3: 315, ft: 357, trb: 991, ast: 503, tov: 337, pf: 489 });
});
