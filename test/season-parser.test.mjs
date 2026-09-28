import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { IngestionOrchestrator } from '../src/application/orchestrator.mjs';
import { createJob, createSnapshot } from '../src/contracts/boundaries.mjs';
import { CORE_STAT_FIELDS } from '../src/contracts/parsed-documents.mjs';
import { canonicalizeSourceUrl, createSourceUrl } from '../src/contracts/source.mjs';
import { MemoryRawStore, InMemoryPersistence } from '../src/persistence/index.mjs';
import { SeasonParser, createProductionParserRegistry } from '../src/parsers/index.mjs';
import { captureSkip, captureSnapshot } from '../fixtures/sports-reference/captures.mjs';

const origin = 'https://www.sports-reference.com';
const seasonPath = '/cbb/schools/example/men/2026.html';
const present = (value) => ({ state: 'present', value });
const BLANK = { state: 'blank' };
const NOT_PUBLISHED = { state: 'unavailable', reason: 'not_published' };
const statColumns = ['mp', ...CORE_STAT_FIELDS.slice(1)];

function snapshot(path, body) {
  const sourceUrl = createSourceUrl('sports-reference', `${origin}${path}`);
  return createSnapshot({
    jobKey: `test:${path}`, sourceUrl, body: Buffer.from(body),
    sourceUrlFrom: (target, baseUrl = sourceUrl.absoluteUrl) => createSourceUrl('sports-reference', target, baseUrl),
  });
}

function table(id, stats, rows, { comment = false } = {}) {
  const head = `<thead><tr>${stats.map((stat) => `<th data-stat="${stat}">${stat}</th>`).join('')}</tr></thead>`;
  const body = rows.map((row) => `<tr${row.className ? ` class="${row.className}"` : ''}>${(row.cells ?? stats).map((stat) => `<td data-stat="${stat}">${row[stat] ?? ''}</td>`).join('')}</tr>`).join('');
  const html = `<table id="${id}">${head}<tbody>${body}</tbody></table>`;
  return comment ? `<!-- ${html} -->` : html;
}

function line(values) { return Object.fromEntries(statColumns.map((stat, index) => [stat, values[index]])); }

const owl = '<a href="/cbb/players/sam-owl-1.html">Sam Owl</a>';
const info = {
  record: '<p><strong>Record:</strong> 3-1&nbsp;(1-0, 1st in <a href="/cbb/conferences/big-east/men/2026.html">Big East MBB</a>)</p>',
  coach: '<p><strong>Coach:</strong> <a href="/cbb/coaches/pat-coach-1.html">Pat Coach</a></p>',
  srs: '<p><strong><a href="/cbb/about/glossary.html#srs">SRS</a>:</strong> 0.00 (180th of 364)</p>',
  sos: '<p><strong>SOS:</strong> </p>',
  ncaa: `<p><strong><a href="/cbb/postseason/men/2026-ncaa.html">NCAA Tournament</a>:</strong>
    (#12 seed in West)<br>Won West First Round (<a href="/cbb/boxscores/x.html">70-61</a>) versus #5 <a href="/cbb/schools/a/men/2026.html">Alpha</a>
    <br>Lost West Second Round (<a href="/cbb/boxscores/y.html">80-66</a>) versus #4 Beta</p>`,
};

function seasonHtml({ noTotals = false, ...overrides } = {}) {
  const parts = { ...info, ...overrides };
  const roster = table('roster', ['player', 'number', 'class', 'pos', 'height', 'weight', 'hometown', 'high_school'], [
    { player: owl, number: '0', class: 'FR', pos: 'G', height: '6-2', weight: '0', hometown: 'Here, NY', high_school: '' },
    { player: 'Walk On', number: '', class: '', pos: '', height: '', weight: '' },
  ]);
  const totals = table('season-total_totals', ['entity', 'games', ...statColumns], [
    { entity: 'Team', games: '4', ...line(['800', '100', '200', '0', '10', '50', '70', '30', '90', '120', '60', '20', '10', '40', '70', '250']) },
    { entity: 'Rank', className: 'note', fg: '12th' },
    { entity: 'Opponent', games: '4', cells: ['entity', 'games', 'mp', ...CORE_STAT_FIELDS.slice(1).map((stat) => `opp_${stat}`)], ...Object.fromEntries(Object.entries(line(['800', '90', '210', '20', '60', '40', '55', '35', '80', '115', '50', '15', '5', '45', '75', '240'])).map(([stat, value]) => [stat === 'mp' ? stat : `opp_${stat}`, value])) },
  ]);
  const playerTotals = table('players_totals', ['ranker', 'name_display', 'games', 'games_started', ...statColumns, 'ft_pct'], [
    { name_display: owl, games: '4', games_started: '4', ...line(['120', '20', '40', '0', '0', '10', '12', '4', '10', '14', '9', '3', '0', '5', '8', '50']), ft_pct: '' },
    { name_display: 'Walk On', games: '1', games_started: '0', ...line(['1', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0']), ft_pct: '' },
  ]);
  const advanced = table('players_advanced', ['name_display', 'per', 'usg_pct', 'ws', 'bpm'], [
    { name_display: owl, per: '15.0', usg_pct: '20.7', ws: '0.0', bpm: '' },
  ], { comment: true });
  return `<!doctype html><div id="info"><h1><span>2025-26</span> <span>Example Owls Men's</span><span>Roster and Stats</span></h1>
    ${Object.values(parts).join('\n')}</div>
    <a href="/cbb/schools/example/men/2026-gamelogs.html">Game Log</a>
    ${roster}${noTotals ? '' : totals}${playerTotals}${advanced}`;
}

function parse(html) { return createProductionParserRegistry().parse('season', '1', snapshot(seasonPath, html)); }

test('season@1 reads the #info summary, including the NCAA seed, region and round results', () => {
  const parsed = parse(seasonHtml());
  assert.equal(parsed.kind, 'valid', parsed.error);
  assert.deepEqual(parsed.warnings, []);
  const { school, endingYear, gameLogUrl, summary } = parsed.document;
  assert.deepEqual({ school, endingYear, gameLogUrl }, { school: 'Example Owls', endingYear: 2026, gameLogUrl: `${origin}/cbb/schools/example/men/2026-gamelogs.html` });
  assert.deepEqual(summary, {
    wins: present(3), losses: present(1), confWins: present(1), confLosses: present(0),
    srs: present(0), sos: BLANK, offRtg: NOT_PUBLISHED, defRtg: NOT_PUBLISHED,
    conference: { name: 'Big East MBB', path: '/cbb/conferences/big-east/men/2026.html' },
    coach: { name: 'Pat Coach', path: '/cbb/coaches/pat-coach-1.html' },
    ncaaTournament: {
      seed: present(12), region: 'West', games: [
        { round: 'First Round', result: 'W', teamScore: 70, opponentScore: 61, opponent: { name: 'Alpha', seed: 5 } },
        { round: 'Second Round', result: 'L', teamScore: 66, opponentScore: 80, opponent: { name: 'Beta', seed: 4 } },
      ],
    },
    extra: { conf_finish: present(1), ap_final_rank: NOT_PUBLISHED },
  });
});

test('season@1 keeps blanks, zeros and unlinked players distinct in the roster and player tables', () => {
  const { roster, teamTotals, players } = parse(seasonHtml()).document;
  assert.deepEqual(roster, [
    { name: 'Sam Owl', playerPath: '/cbb/players/sam-owl-1.html', number: '0', class: 'FR', position: 'G', heightIn: present(74), weight: present(0),
      extra: { hometown: present('Here, NY'), high_school: BLANK, rsci: NOT_PUBLISHED } },
    { name: 'Walk On', playerPath: null, number: null, class: null, position: null, heightIn: BLANK, weight: BLANK,
      extra: { hometown: BLANK, high_school: BLANK, rsci: NOT_PUBLISHED } },
  ]);
  assert.deepEqual(teamTotals.team.games, present(4));
  assert.deepEqual(teamTotals.team.stats.fg3, present(0));
  assert.equal('extra' in teamTotals.team.stats, false);
  assert.deepEqual(teamTotals.opponent.stats.pts, present(240));
  assert.deepEqual(teamTotals.opponent.stats.minutes, present(800));
  assert.deepEqual(players.map(({ name, playerPath }) => ({ name, playerPath })),
    [{ name: 'Sam Owl', playerPath: '/cbb/players/sam-owl-1.html' }, { name: 'Walk On', playerPath: null }]);
  assert.deepEqual(players[0].stats.fg3, present(0));
  assert.deepEqual(players[0].stats.extra, { ft_pct: BLANK });
  assert.deepEqual(players[0].advanced, { per: present(15), usg_pct: present(0.207), ws: present(0), bpm: BLANK });
  const notListed = { state: 'unavailable', reason: 'not_listed' };
  assert.deepEqual(players[1].advanced, { per: notListed, usg_pct: notListed, ws: notListed, bpm: notListed });
});

test('season@1 reports no totals table, no tournament and no game-log link as null', () => {
  const html = seasonHtml({ ncaa: '', noTotals: true }).replace(/<a href="[^"]*-gamelogs\.html">Game Log<\/a>/, '');
  const parsed = parse(html);
  assert.equal(parsed.kind, 'valid');
  assert.equal(parsed.document.teamTotals, null);
  assert.equal(parsed.document.summary.ncaaTournament, null);
  assert.equal(parsed.document.gameLogUrl, null);
});

test('season@1 leaves a multi-coach season coach null and says why in a warning', () => {
  const parsed = parse(seasonHtml({ coach: '<p><strong>Coach:</strong> <a href="/cbb/coaches/a-1.html">A</a> (1-0), <a href="/cbb/coaches/b-1.html">B</a> (2-1)</p>' }));
  assert.equal(parsed.kind, 'valid');
  assert.equal(parsed.document.summary.coach, null);
  assert.match(parsed.warnings[0], /lists 2 coaches/);
});

test('season@1 fails closed on summary and table changes it cannot read', () => {
  const cases = [
    [seasonHtml({ record: '<p><strong>Record:</strong> three and one</p>' }), /season record is unexpected/],
    [seasonHtml({ record: '' }), /no Record line/],
    [seasonHtml({ ncaa: '<p><strong>NCAA Tournament:</strong> (#12 seed in West)<br>Advanced by forfeit</p>' }), /game line is unexpected/],
    [seasonHtml().replace('2025-26', '2024-25'), /does not match 2025-26/],
    [seasonHtml().replace('>Team<', '>Squad<'), /expected Team, Opponent/],
    [seasonHtml().replace('<td data-stat="height">6-2', '<td data-stat="height">74'), /not feet-inches/],
  ];
  for (const [html, expected] of cases) {
    const parsed = parse(html);
    assert.equal(parsed.kind, 'structural_failure');
    assert.match(parsed.error, expected);
  }
});

test('season@1 fails closed on the layout-shift fixture', () => {
  const body = readFileSync(new URL('fixtures/sports-reference/season-layout-shift.html', import.meta.url));
  const parser = new SeasonParser();
  const parsed = parser.parse(snapshot(seasonPath, body));
  assert.equal(parser.version(), '1');
  assert.equal(parsed.kind, 'structural_failure');
  assert.match(parsed.error, /table #roster is missing the height column/);
});

test('a season layout shift is persisted as parse_failed with parser version and failure details', async () => {
  const now = new Date('2026-09-27T00:00:00Z');
  const clock = () => now;
  const rawStore = new MemoryRawStore();
  const raw = rawStore.put(readFileSync(new URL('fixtures/sports-reference/season-layout-shift.html', import.meta.url)));
  const persistence = new InMemoryPersistence(clock);
  const sourceUrl = createSourceUrl('sports-reference', `${origin}${seasonPath}`);
  persistence.addJob(createJob({ key: 'shifted-season', pageType: 'season', sourceUrl, canonicalPath: canonicalizeSourceUrl(sourceUrl), parserVersion: '1' }));
  const orchestrator = new IngestionOrchestrator({
    fetcher: { fetch: async () => ({ kind: 'fetched', sourceFetchId: 'fetch-shifted-season', checksum: raw.checksum }) },
    parsers: createProductionParserRegistry(), persistence, rawStore, clock,
  });
  const result = await orchestrator.runOnce('parser-test');
  assert.equal(result.events[0].kind, 'parse_failed');
  assert.equal(persistence.getJob('shifted-season').state, 'parse_failed');
  assert.deepEqual(persistence.parseRuns.map(({ parserName, parserVersion, status }) => ({ parserName, parserVersion, status })), [
    { parserName: 'season', parserVersion: '1', status: 'structural_failure' },
  ]);
  assert.match(persistence.parseRuns[0].failureDetails.error, /height column/);
});

test('real season captures parse into exact frozen documents', {
  skip: captureSkip('/cbb/schools/duke/men/2024.html', '/cbb/schools/le-moyne/men/2024.html'),
}, () => {
  const registry = createProductionParserRegistry();
  const duke = registry.parse('season', '1', captureSnapshot('/cbb/schools/duke/men/2024.html'));
  assert.equal(duke.kind, 'valid');
  assert.deepEqual(duke.warnings, []);
  const { summary } = duke.document;
  assert.equal(duke.document.school, 'Duke Blue Devils');
  assert.equal(duke.document.gameLogUrl, `${origin}/cbb/schools/duke/men/2024-gamelogs.html`);
  assert.deepEqual([summary.wins, summary.losses, summary.confWins, summary.confLosses], [present(27), present(9), present(15), present(5)]);
  assert.deepEqual([summary.srs, summary.sos, summary.offRtg, summary.defRtg], [present(20.67), present(8.36), present(117.1), present(98.8)]);
  assert.deepEqual(summary.conference, { name: 'ACC MBB', path: '/cbb/conferences/acc/men/2024.html' });
  assert.deepEqual(summary.coach, { name: 'Jon Scheyer', path: '/cbb/coaches/jon-scheyer-1.html' });
  assert.deepEqual(summary.extra, { conf_finish: present(2), ap_final_rank: present(9) });
  assert.deepEqual(summary.ncaaTournament.seed, present(4));
  assert.equal(summary.ncaaTournament.region, 'South');
  assert.deepEqual(summary.ncaaTournament.games.map((game) => [game.round, game.result, game.teamScore, game.opponentScore, game.opponent.name, game.opponent.seed]), [
    ['First Round', 'W', 64, 47, 'Vermont', 13],
    ['Second Round', 'W', 93, 55, 'James Madison', 12],
    ['Regional Semifinal', 'W', 54, 51, 'Houston', 1],
    ['Regional Final', 'L', 64, 76, 'NC State', 11],
  ]);
  assert.equal(duke.document.roster.length, 13);
  assert.deepEqual(duke.document.roster[0], {
    name: 'Kyle Filipowski', playerPath: '/cbb/players/kyle-filipowski-1.html', number: '30', class: 'SO', position: 'C',
    heightIn: present(84), weight: present(230),
    extra: { hometown: present('Westtown, NY'), high_school: present('Wilbraham & Monson (MA)'), rsci: present('4 (2022)') },
  });
  assert.deepEqual(duke.document.roster.find((player) => player.name === 'Ryan Young').extra.rsci, BLANK);
  assert.deepEqual(duke.document.teamTotals.team.stats.pts, present(2830));
  assert.deepEqual(duke.document.teamTotals.opponent.stats.pts, present(2387));
  assert.deepEqual(duke.document.teamTotals.team.games, present(36));
  assert.equal(duke.document.players.length, 13);
  const stewart = duke.document.players.find((player) => player.playerPath === '/cbb/players/sean-stewart-2.html');
  assert.deepEqual([stewart.stats.fg3a, stewart.stats.extra.fg3_pct], [present(0), BLANK]);
  const filipowski = duke.document.players[0];
  assert.deepEqual([filipowski.stats.minutes, filipowski.stats.pts, filipowski.advanced.per, filipowski.advanced.usg_pct],
    [present(1095), present(591), present(26), present(0.277)]);
  // Player season totals add up to the team's totals for the counting stats players carry.
  assert.equal(duke.document.players.reduce((sum, player) => sum + player.stats.pts.value, 0), 2830);

  const leMoyne = registry.parse('season', '1', captureSnapshot('/cbb/schools/le-moyne/men/2024.html'));
  assert.equal(leMoyne.kind, 'valid');
  assert.equal(leMoyne.document.school, 'Le Moyne Dolphins');
  assert.equal(leMoyne.document.summary.ncaaTournament, null);
  assert.deepEqual(leMoyne.document.summary.extra.ap_final_rank, NOT_PUBLISHED);
  assert.deepEqual([leMoyne.document.summary.wins, leMoyne.document.summary.losses, leMoyne.document.summary.srs], [present(15), present(17), present(-11.07)]);
  assert.ok(leMoyne.document.roster.every((player) => player.extra.rsci.state === 'unavailable'));
  assert.equal(leMoyne.document.players.length, 12);
  assert.equal(leMoyne.document.players.find((player) => player.playerPath === '/cbb/players/darrick-jonesjr-1.html').name, 'Darrick Jones Jr.');
});
