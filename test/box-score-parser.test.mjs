import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { IngestionOrchestrator } from '../src/application/orchestrator.mjs';
import { createJob, createSnapshot } from '../src/contracts/boundaries.mjs';
import { canonicalPathString, canonicalizeSourceUrl, createSourceUrl } from '../src/contracts/source.mjs';
import { Normalizer } from '../src/domain/index.mjs';
import { MemoryRawStore, InMemoryPersistence } from '../src/persistence/index.mjs';
import { writeNormalizedPage } from '../src/persistence/postgres-domain.mjs';
import { BoxScoreParser, createProductionParserRegistry } from '../src/parsers/index.mjs';
import { captureSkip, captureSnapshot } from '../fixtures/sports-reference/captures.mjs';

const origin = 'https://www.sports-reference.com';
const boxPath = '/cbb/boxscores/2026-01-02-19-home-u.html';
const p = (value) => ({ state: 'present', value });
const BLANK = { state: 'blank' };
const dnp = { state: 'unavailable', reason: 'did_not_play' };

function snapshot(path, body) {
  const sourceUrl = createSourceUrl('sports-reference', `${origin}${path}`);
  return createSnapshot({
    jobKey: `test:${path}`, sourceUrl, body: Buffer.from(body),
    sourceUrlFrom: (target, baseUrl = sourceUrl.absoluteUrl) => createSourceUrl('sports-reference', target, baseUrl),
  });
}

// ---------------------------------------------------------------------------
// A hand-made box score in the Sports Reference layout: an unlinked (non-D-I)
// away team, a linked home team, two overtimes, commented summary tables, a
// Did Not Play row, blank percentages and real zeros.
// ---------------------------------------------------------------------------

const BASIC = ['mp', 'fg', 'fga', 'fg_pct', 'fg3', 'fg3a', 'ft', 'fta', 'orb', 'drb', 'trb', 'ast', 'stl', 'blk', 'tov', 'pf', 'pts', 'game_score'];
const ADVANCED = ['mp', 'ts_pct', 'efg_pct', 'orb_pct', 'usg_pct', 'bpm'];
const FOUR_FACTORS = ['pace', 'efg_pct', 'tov_pct', 'orb_pct', 'ft_rate', 'team_off_rtg'];
const HOME_LINK = '/cbb/schools/home-u/men/2026.html';

function cells(stats, values) { return stats.map((stat, index) => `<td data-stat="${stat}">${values[index] ?? ''}</td>`).join(''); }
function headerRow(first, stats) { return `<tr><th data-stat="player">${first}</th>${stats.map((stat) => `<th data-stat="${stat}">${stat}</th>`).join('')}</tr>`; }
function playerCell(name, href) { return `<th data-stat="player">${href ? `<a href="${href}">${name}</a>` : name}</th>`; }

function teamTable(kind, slug, stats, rows, totals) {
  const body = rows.map(([name, href, values]) => (name === 'Reserves'
    ? `<tr class="thead">${headerRow('Reserves', stats).slice(4, -5)}</tr>`
    : `<tr>${playerCell(name, href)}${typeof values === 'string'
      ? `<td class="center iz" data-stat="reason" colspan="${stats.length}">${values}</td>` : cells(stats, values)}</tr>`)).join('');
  const foot = totals ? `<tfoot><tr><th data-stat="player">School Totals</th>${cells(stats, totals)}</tr></tfoot>` : '';
  return `<table id="box-score-${kind}-${slug}"><thead>${headerRow('Starters', stats)}</thead><tbody>${body}</tbody>${foot}</table>`;
}

function boxHtml({
  awayScore = '61', lineScore = [['30', '25', '4', '2', '61'], ['28', '27', '4', '5', '64']], periods = ['1', '2', 'OT', '2OT'],
  meta = ['January 2, 2026', '', 'Attendance: 1,234'], homeSlug = 'home-u', homeFourFactorOrb = '31.9', tfoot = true,
} = {}) {
  const lineRows = [['Visitors', null], ['Home U', HOME_LINK]].map(([name, href], index) => `<tr><th data-stat="team">${href ? `<a href='${href}'>${name}</a>` : name}</th>${cells([...periods, 'T'], lineScore[index])}</tr>`).join('');
  const fourRows = [['Visitors', null, ['68.0', '.450', '12.0', '20.0', '.300', '89.7']], ['Home U', HOME_LINK, ['68.0', '.480', '10.5', homeFourFactorOrb, '.250', '94.1']]]
    .map(([name, href, values]) => `<tr><th data-stat="school_name">${href ? `<a href="${href}">${name}</a>` : name}</th>${cells(FOUR_FACTORS, values)}</tr>`).join('');
  const home = [
    ['Linked Starter', '/cbb/players/linked-starter-1.html', ['32:30', '7', '12', '.583', '0', '3', '4', '5', '1', '6', '7', '3', '0', '1', '2', '3', '18', '14.2']],
    ['Reserves'],
    ['Zero Reserve', '/cbb/players/zero-reserve-1.html', ['2', '0', '0', '', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0.0']],
    ['Bench Walk-On', null, 'Did Not Play'],
  ];
  const homeAdvanced = [
    ['Linked Starter', '/cbb/players/linked-starter-1.html', ['32:30', '.620', '.583', '', '24.5', '3.1']],
    ['Reserves'],
    ['Zero Reserve', '/cbb/players/zero-reserve-1.html', ['2', '', '', '', '', '-1.0']],
    ['Bench Walk-On', null, 'Did Not Play'],
  ];
  const away = [['Unlinked Guard', null, ['40', '20', '45', '.444', '5', '15', '16', '20', '10', '25', '35', '12', '6', '2', '14', '18', '61', '']]];
  const awayAdvanced = [['Unlinked Guard', null, ['40', '.500', '.500', '', '100.0', '']]];
  const teamTotals = (values) => (tfoot ? values : null);
  return `<!doctype html>
<div class="scorebox">
  <div class="scorebox_team" id="sb_team_0"><div><strong><a>Visitors</a></strong></div><div class="scores"><div class="score">${awayScore}</div></div></div>
  <div class="scorebox_team" id="sb_team_1"><div><strong><a href="${HOME_LINK}">Home U</a></strong></div><div class="scores"><div class="score">64</div></div></div>
  <div class="scorebox_meta">${meta.map((line) => `<div>${line}</div>`).join('')}<div><em>Logos <a href="#">via Sports Logos.net</a></em></div></div>
</div>
<div id="all_line-score"><!-- <table id="line-score"><thead><tr><th data-stat="team"></th>${periods.map((period) => `<th data-stat="${period}">${period}</th>`).join('')}<th data-stat="T">T</th></tr></thead><tbody>${lineRows}</tbody></table> --></div>
<div id="all_four-factors"><!-- <table id="four-factors"><thead><tr><th data-stat="school_name"></th>${FOUR_FACTORS.map((stat) => `<th data-stat="${stat}">${stat}</th>`).join('')}</tr></thead><tbody>${fourRows}</tbody></table> --></div>
${teamTable('basic', 'visitors', BASIC, away, teamTotals(['225', '20', '45', '.444', '5', '15', '16', '20', '10', '25', '35', '12', '6', '2', '14', '18', '61', '']))}
${teamTable('advanced', 'visitors', ADVANCED, awayAdvanced, teamTotals(['225', '.500', '.450', '', '100.0', '']))}
${teamTable('basic', homeSlug, BASIC, home, teamTotals(['225', '7', '12', '.583', '0', '3', '4', '5', '1', '6', '7', '3', '0', '1', '2', '3', '64', '']))}
${teamTable('advanced', homeSlug, ADVANCED, homeAdvanced, teamTotals(['225', '.620', '.480', '31.9', '100.0', '']))}`;
}

const parse = (html) => createProductionParserRegistry().parse('box_score', '1', snapshot(boxPath, html));

test('box_score@1 reads both teams, overtime periods and scorebox facts into the frozen shape', () => {
  const parsed = parse(boxHtml());
  assert.equal(parsed.kind, 'valid', parsed.error);
  const { teams, ...game } = parsed.document;
  assert.deepEqual(game, {
    date: '2026-01-02', status: 'final', gameType: null, description: null, venue: null,
    attendance: p(1234), overtimes: 2,
  });
  assert.deepEqual(teams.map(({ side, name, schoolPath, finalScore, lineScore }) => ({ side, name, schoolPath, finalScore, lineScore })), [
    { side: 'away', name: 'Visitors', schoolPath: null, finalScore: p(61), lineScore: [p(30), p(25), p(4), p(2)] },
    { side: 'home', name: 'Home U', schoolPath: '/cbb/schools/home-u/men/', finalScore: p(64), lineScore: [p(28), p(27), p(4), p(5)] },
  ]);
});

test('box_score@1 keeps real zeros, blank cells, Did Not Play rows and unlinked players distinct', () => {
  const [away, home] = parse(boxHtml()).document.teams;
  const [starter, zero, walkOn] = home.players;
  assert.deepEqual(starter.stats, {
    minutes: p(32.5), fg: p(7), fga: p(12), fg3: p(0), fg3a: p(3), ft: p(4), fta: p(5), orb: p(1), drb: p(6), trb: p(7),
    ast: p(3), stl: p(0), blk: p(1), tov: p(2), pf: p(3), pts: p(18), extra: { fg_pct: p(0.583), game_score: p(14.2) },
  });
  assert.deepEqual([starter.name, starter.playerPath, starter.starter], ['Linked Starter', '/cbb/players/linked-starter-1.html', true]);
  assert.deepEqual([zero.starter, zero.stats.pts, zero.stats.minutes, zero.stats.extra.fg_pct], [false, p(0), p(2), BLANK]);
  assert.deepEqual(zero.advanced, { ts_pct: BLANK, efg_pct: BLANK, orb_pct: BLANK, usg_pct: BLANK, bpm: p(-1) });
  assert.deepEqual(walkOn, {
    name: 'Bench Walk-On', playerPath: null, starter: false,
    stats: {
      minutes: dnp, fg: dnp, fga: dnp, fg3: dnp, fg3a: dnp, ft: dnp, fta: dnp, orb: dnp, drb: dnp, trb: dnp,
      ast: dnp, stl: dnp, blk: dnp, tov: dnp, pf: dnp, pts: dnp, extra: { fg_pct: dnp, game_score: dnp },
    },
    advanced: { ts_pct: dnp, efg_pct: dnp, orb_pct: dnp, usg_pct: dnp, bpm: dnp },
  });
  assert.deepEqual(away.players.map(({ name, playerPath, starter }) => ({ name, playerPath, starter })),
    [{ name: 'Unlinked Guard', playerPath: null, starter: true }]);
  assert.deepEqual(away.players[0].stats.extra.game_score, BLANK);
});

test('box_score@1 stores printed percentage points as fractions and joins four factors to the advanced totals', () => {
  const [away, home] = parse(boxHtml()).document.teams;
  assert.deepEqual(home.advanced, {
    ts_pct: p(0.62), efg_pct: p(0.48), orb_pct: p(0.319), usg_pct: p(1), bpm: BLANK,
    pace: p(68), tov_pct: p(0.105), ft_rate: p(0.25), team_off_rtg: p(94.1),
  });
  assert.deepEqual(home.players[0].advanced.usg_pct, p(0.245));
  // An advanced total the page leaves blank takes the four-factor figure.
  assert.deepEqual(away.advanced.orb_pct, p(0.2));
  assert.deepEqual([home.stats.minutes, home.stats.pts, home.stats.extra.game_score], [p(225), p(64), BLANK]);
});

test('box_score@1 marks unpublished attendance, blank venue and missing totals without inventing values', () => {
  const parsed = parse(boxHtml({ meta: ['January 2, 2026', 'Home Arena, Town, State', 'Conference Tournament'], tfoot: false }));
  assert.equal(parsed.kind, 'valid', parsed.error);
  assert.deepEqual([parsed.document.venue, parsed.document.description, parsed.document.attendance],
    ['Home Arena, Town, State', 'Conference Tournament', { state: 'unavailable', reason: 'not_published' }]);
  assert.ok(parsed.document.teams.every((team) => team.stats === null));
  assert.deepEqual(Object.keys(parsed.document.teams[1].advanced), ['pace', 'efg_pct', 'tov_pct', 'orb_pct', 'ft_rate', 'team_off_rtg']);
});

test('box_score@1 reports a game without both final scores as incomplete', () => {
  const parsed = parse(boxHtml({ awayScore: '', lineScore: [['', '', '', '', ''], ['28', '27', '4', '5', '64']] }));
  assert.equal(parsed.kind, 'valid', parsed.error);
  assert.equal(parsed.document.status, 'incomplete');
  assert.deepEqual(parsed.document.teams[0].finalScore, BLANK);
  assert.deepEqual(parsed.document.teams[0].lineScore, [BLANK, BLANK, BLANK, BLANK]);
});

test('box_score@1 fails closed when the page contradicts itself or its tables do not match the scorebox', () => {
  const cases = [
    [{ lineScore: [['30', '25', '4', '1', '61'], ['28', '27', '4', '5', '64']] }, /Visitors line score periods do not add up to 61/],
    [{ lineScore: [['30', '25', '4', '2', '60'], ['28', '27', '4', '5', '64']] }, /total 60 differs from the final score 61/],
    [{ homeFourFactorOrb: '30.0' }, /four-factor orb_pct 0\.3 differs from its advanced total 0\.319/],
    [{ homeSlug: 'other-u' }, /home team Home U has table #box-score-basic-other-u/],
    [{ periods: ['1', '2', 'Q3', 'OT'] }, /line score period is unexpected: Q3/],
    [{ meta: ['Sometime', ''] }, /scorebox date is unexpected: Sometime/],
  ];
  for (const [options, expected] of cases) {
    const parsed = parse(boxHtml(options));
    assert.equal(parsed.kind, 'structural_failure', String(expected));
    assert.match(parsed.error, expected);
  }
});

test('box_score@1 fails closed on the layout-shift fixture', () => {
  const parser = new BoxScoreParser();
  const body = readFileSync(new URL('fixtures/sports-reference/box-score-layout-shift.html', import.meta.url));
  const parsed = parser.parse(snapshot(boxPath, body));
  assert.equal(parser.version(), '1');
  assert.equal(parsed.kind, 'structural_failure');
  assert.match(parsed.error, /box-score-basic-visitors is missing the pts column/);
});

test('a box score layout shift is persisted as parse_failed with parser version and failure details', async () => {
  const now = new Date('2026-09-27T00:00:00Z');
  const clock = () => now;
  const rawStore = new MemoryRawStore();
  const raw = rawStore.put(readFileSync(new URL('fixtures/sports-reference/box-score-layout-shift.html', import.meta.url)));
  const persistence = new InMemoryPersistence(clock);
  const sourceUrl = createSourceUrl('sports-reference', `${origin}${boxPath}`);
  persistence.addJob(createJob({ key: 'shifted-box', pageType: 'box_score', sourceUrl, canonicalPath: canonicalizeSourceUrl(sourceUrl), parserVersion: '1' }));
  const orchestrator = new IngestionOrchestrator({
    fetcher: { fetch: async () => ({ kind: 'fetched', sourceFetchId: 'fetch-shifted-box', checksum: raw.checksum }) },
    parsers: createProductionParserRegistry(), persistence, rawStore, clock,
  });
  const result = await orchestrator.runOnce('parser-test');
  assert.equal(result.events[0].kind, 'parse_failed');
  assert.equal(persistence.getJob('shifted-box').state, 'parse_failed');
  assert.deepEqual(persistence.parseRuns.map(({ parserName, parserVersion, status }) => ({ parserName, parserVersion, status })), [
    { parserName: 'box_score', parserVersion: '1', status: 'structural_failure' },
  ]);
  assert.match(persistence.parseRuns[0].failureDetails.error, /missing the pts column/);
});

// ---------------------------------------------------------------------------
// Persistence fit: the parsed document goes through the normalizer into the
// batched two-team game write (#84/#86), recorded without a database.
// ---------------------------------------------------------------------------

function recordingClient() {
  const statements = [];
  let nextId = 100;
  const tuples = (text, values) => {
    const width = text.slice(text.indexOf('(') + 1, text.indexOf(')')).split(',').length;
    return Array.from({ length: values.length / width }, (_, index) => values.slice(index * width, (index + 1) * width));
  };
  return {
    statements,
    async query(text, values = []) {
      statements.push({ text, values, rows: tuples(text, values) });
      if (/RETURNING id,canonical_source_path/.test(text)) return { rows: tuples(text, values).map((row) => ({ id: nextId++, canonical_source_path: row[1] })) };
      if (/RETURNING id,side/.test(text)) return { rows: tuples(text, values).map((row) => ({ id: nextId++, side: row[1] })) };
      if (/RETURNING id/.test(text)) return { rows: [{ id: nextId++ }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
}

async function writeBoxScore(document, path) {
  const sourceUrl = createSourceUrl('sports-reference', `${origin}${path}`);
  const canonical = canonicalizeSourceUrl(sourceUrl);
  const canonicalPath = canonicalPathString(canonical);
  const job = { id: 9, provider_id: 'sports-reference', canonical_path: canonicalPath, page_type: 'box_score', source_url: sourceUrl.absoluteUrl, school_source_path: null };
  const jobKey = `sports-reference:${canonicalPath}:box_score`;
  const page = new Normalizer().normalize('box_score', document, { jobKey, canonicalPath: canonical });
  const client = recordingClient();
  await writeNormalizedPage(client, job, page, { parserName: 'box_score', parserVersion: '1' }, '5');
  const inserts = (table) => client.statements.filter((statement) => new RegExp(`INSERT INTO ${table}\\s*\\(`).test(statement.text));
  return { page, inserts };
}

test('a parsed box score fits the batched two-team game write, keeping unlinked teams and players by row', async () => {
  const { page, inserts } = await writeBoxScore(parse(boxHtml()).document, boxPath);
  assert.equal(page.kind, 'game');
  assert.deepEqual([page.data.gameDate, page.data.neutralSite, page.data.away, page.data.home], ['2026-01-02', null, 'Visitors', 'Home U']);
  assert.deepEqual(inserts('games')[0].values.slice(3, 8), ['2026-01-02', 'final', null, null, 2]);
  assert.deepEqual(inserts('game_teams')[0].rows.map((row) => row.slice(1, 5)), [
    ['away', null, 'Visitors', 61],
    ['home', 'www.sports-reference.com/cbb/schools/home-u/men', 'Home U', 64],
  ]);
  assert.equal(inserts('team_game_stats')[0].rows.length, 2);
  assert.deepEqual(inserts('players')[0].rows.map((row) => row[1]).sort(),
    ['www.sports-reference.com/cbb/players/linked-starter-1.html', 'www.sports-reference.com/cbb/players/zero-reserve-1.html']);
  const [linked, unlinked] = inserts('player_game_stats');
  assert.deepEqual(linked.rows.map((row) => [row[1], row[3], row[4]]), [[0, 'Linked Starter', true], [1, 'Zero Reserve', false]]);
  assert.deepEqual(unlinked.rows.map((row) => [row[1], row[3], row[4]]), [[0, 'Unlinked Guard', true], [2, 'Bench Walk-On', false]]);
  // Did Not Play keeps its reason in value_states while the named columns stay NULL.
  const walkOn = unlinked.rows[1];
  assert.ok(walkOn.slice(5, 21).every((value) => value === null));
  assert.deepEqual(JSON.parse(walkOn[23]).pts, dnp);
});

// ---------------------------------------------------------------------------
// Real captures (gitignored; skipped when fixtures/sports-reference/raw/ is absent).
// ---------------------------------------------------------------------------

const CAPTURES = Object.freeze({
  '/cbb/boxscores/2024-01-27-16-duke.html': {
    date: '2024-01-27', venue: 'Cameron Indoor Stadium, Durham, North Carolina', description: null, overtimes: 0,
    teams: [['away', 'Clemson', '/cbb/schools/clemson/men/', 71, [26, 45], 9], ['home', 'Duke', '/cbb/schools/duke/men/', 72, [32, 40], 8]],
  },
  '/cbb/boxscores/2024-02-03-18-north-carolina.html': {
    date: '2024-02-03', venue: 'Dean Smith Center, Chapel Hill, North Carolina', description: null, overtimes: 0,
    teams: [['away', 'Duke', '/cbb/schools/duke/men/', 84, [35, 49], 8], ['home', 'UNC', '/cbb/schools/north-carolina/men/', 93, [45, 48], 8]],
  },
  '/cbb/boxscores/2024-03-29-21-houston.html': {
    date: '2024-03-29', venue: 'American Airlines Center, Dallas, Texas', description: 'South - Regional Semifinal', overtimes: 0,
    teams: [['away', 'Duke', '/cbb/schools/duke/men/', 54, [23, 31], 8], ['home', 'Houston', '/cbb/schools/houston/men/', 51, [22, 29], 9]],
  },
  '/cbb/boxscores/2024-02-15-19-le-moyne.html': {
    date: '2024-02-15', venue: null, description: null, overtimes: 1,
    teams: [['away', 'Central Connecticut', '/cbb/schools/central-connecticut-state/men/', 64, [30, 30, 4], 8], ['home', 'Le Moyne', '/cbb/schools/le-moyne/men/', 69, [27, 33, 9], 8]],
  },
  '/cbb/boxscores/2023-11-13-19-le-moyne.html': {
    date: '2023-11-13', venue: null, description: null, overtimes: 0,
    teams: [['away', 'SUNY Canton', null, 46, [23, 23], 20], ['home', 'Le Moyne', '/cbb/schools/le-moyne/men/', 105, [60, 45], 12]],
  },
});

const parseCapture = (path) => createProductionParserRegistry().parse('box_score', '1', captureSnapshot(path));

test('real box scores parse home, away, neutral-site, overtime and non-D-I games into exact frozen documents', {
  skip: captureSkip(...Object.keys(CAPTURES)),
}, () => {
  for (const [path, expected] of Object.entries(CAPTURES)) {
    const parsed = parseCapture(path);
    assert.equal(parsed.kind, 'valid', `${path}: ${parsed.error}`);
    const document = parsed.document;
    assert.deepEqual({ date: document.date, venue: document.venue, description: document.description, overtimes: document.overtimes },
      { date: expected.date, venue: expected.venue, description: expected.description, overtimes: expected.overtimes }, path);
    assert.deepEqual([document.status, document.gameType, document.attendance, 'context' in document],
      ['final', null, { state: 'unavailable', reason: 'not_published' }, false], path);
    assert.deepEqual(document.teams.map((team) => [team.side, team.name, team.schoolPath, team.finalScore.value,
      team.lineScore.map((entry) => entry.value), team.players.length]), expected.teams, path);
    for (const team of document.teams) {
      // Team totals agree with the final score, and exactly five starters are listed.
      assert.deepEqual(team.stats.pts, team.finalScore, path);
      assert.equal(team.players.filter((player) => player.starter).length, 5, path);
      assert.ok(team.players.every((player) => player.starter !== null), path);
      assert.equal(team.players.reduce((sum, player) => sum + player.stats.pts.value, 0), team.finalScore.value, path);
    }
  }
});

test('real box score player lines carry linked identities, decimal minutes and fractional percentages', {
  skip: captureSkip('/cbb/boxscores/2024-01-27-16-duke.html', '/cbb/boxscores/2023-11-13-19-le-moyne.html'),
}, () => {
  const duke = parseCapture('/cbb/boxscores/2024-01-27-16-duke.html').document.teams[1];
  assert.deepEqual(duke.players[0], {
    name: 'Tyrese Proctor', playerPath: '/cbb/players/tyrese-proctor-1.html', starter: true,
    stats: {
      minutes: p(38), fg: p(5), fga: p(10), fg3: p(4), fg3a: p(6), ft: p(4), fta: p(4), orb: p(0), drb: p(5), trb: p(5),
      ast: p(2), stl: p(2), blk: p(0), tov: p(3), pf: p(0), pts: p(18),
      extra: { fg_pct: p(0.5), fg2: p(1), fg2a: p(4), fg2_pct: p(0.25), fg3_pct: p(0.667), ft_pct: p(1), game_score: p(14.9) },
    },
    advanced: duke.players[0].advanced,
  });
  // Rebound, assist and usage rates are not printed for players: blank, not zero.
  assert.deepEqual([duke.players[0].advanced.orb_pct, duke.players[0].advanced.usg_pct], [BLANK, BLANK]);
  const stewart = duke.players.find((player) => player.name === 'Sean Stewart');
  assert.deepEqual([stewart.starter, stewart.stats.fga, stewart.stats.extra.fg_pct, stewart.advanced.ts_pct], [false, p(0), BLANK, BLANK]);
  assert.deepEqual([duke.advanced.orb_pct, duke.advanced.usg_pct, duke.advanced.pace, duke.advanced.bpm], [p(0.114), p(1), p(70.6), BLANK]);

  // Non-D-I opponent: no school or player identities, and no BPM column at all.
  const canton = parseCapture('/cbb/boxscores/2023-11-13-19-le-moyne.html').document.teams[0];
  assert.ok(canton.players.every((player) => player.playerPath === null));
  assert.ok(canton.players.every((player) => !('bpm' in player.advanced)));
  assert.deepEqual(canton.stats.extra.ft_pct, p(0.833));
});

test('real box scores fit the batched two-team game write', { skip: captureSkip(...Object.keys(CAPTURES)) }, async () => {
  for (const path of Object.keys(CAPTURES)) {
    const document = parseCapture(path).document;
    const { inserts } = await writeBoxScore(document, path);
    assert.deepEqual(inserts('game_teams')[0].rows.map((row) => row[1]), ['away', 'home'], path);
    const written = inserts('player_game_stats').reduce((count, statement) => count + statement.rows.length, 0);
    assert.equal(written, document.teams.reduce((count, team) => count + team.players.length, 0), path);
  }
});
