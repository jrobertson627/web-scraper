import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createFixtureApplication } from '../src/application/composition-root.mjs';
import { SportsReferenceSourceAdapter } from '../src/application/sports-reference-source-adapter.mjs';
import { boxScoreDocument, gameLogDocument, schoolIndexDocument, seasonDocument, statLine } from '../src/application/fixture-documents.mjs';
import { createApiServer, createQueryService } from '../src/api/index.mjs';
import { assertParsedDocument } from '../src/contracts/parsed-documents.mjs';
import {
  API_FIELDS, DOCUMENT_FIELDS, MAPPED_RETAINED_FIELDS, fieldCategories, retainFields, unretainedFields,
} from '../src/contracts/retained-fields.mjs';
import { present, unavailable } from '../src/contracts/value-state.mjs';
import { Normalizer } from '../src/domain/index.mjs';
import { PRODUCTION_PARSERS, createProductionParserRegistry } from '../src/parsers/index.mjs';
import { PostgresPersistence } from '../src/persistence/postgres.mjs';
import { captureManifest, captureSkip, captureSnapshot, captureSourceUrl } from '../fixtures/sports-reference/captures.mjs';
import { foundationCorpus } from '../fixtures/foundation-corpus.mjs';

// The data contract's retained fields are enforced where pages are normalized
// and where the API serves them (#89).

const contract = JSON.parse(readFileSync(new URL('../config/personal-use.data-contract.json', import.meta.url), 'utf8'));
const retained = contract.retainedFields;
const listed = new Set(retained);
const captures = Object.keys(captureManifest);

test('every field the stored documents and API models map to is listed in the data contract', () => {
  assert.deepEqual(MAPPED_RETAINED_FIELDS.filter((field) => !listed.has(field)), []);
});

test('the data contract lists no field that nothing stores or serves, except raw snapshots', () => {
  assert.deepEqual(retained.filter((field) => !MAPPED_RETAINED_FIELDS.includes(field)), ['raw_html_snapshots']);
});

test('every field of a fully populated frozen document maps to a data-contract field', () => {
  const line = statLine({ pts: 70 }, { fg_pct: present(0.45) });
  const game = { location: 'neutral', opponent: { name: 'Other', schoolPath: '/other/' }, status: 'final', date: '2026-01-02',
    gameType: 'NCAA', teamScore: 70, opponentScore: 60, teamStats: line, opponentStats: line, boxScoreUrl: 'https://x.example/box.html' };
  const season = seasonDocument({ school: 'A', endingYear: 2026, gameLogUrl: 'https://x.example/log.html', games: [game],
    players: [{ name: 'P', playerPath: '/p', lines: [line] }] });
  season.summary.conference = { name: 'Conf', path: '/conf' };
  season.summary.coach = { name: 'Coach', path: '/coach' };
  season.summary.ncaaTournament = { seed: present(1), region: 'East', games: [] };
  season.summary.extra = { conf_finish: present(1), ap_final_rank: present(4) };
  season.roster[0].extra = { hometown: present('Town') };
  season.teamTotals.extra = { pace: present(70) };
  season.players[0].advanced = { per: present(20) };
  const index = schoolIndexDocument([{ name: 'A', path: '/a', historyUrl: 'https://x.example/a/', to: 2026, from: 1900, city: 'C', state: 'S' }]);
  Object.assign(index.schools[0], { aliases: ['Alpha'], aggregateFields: { w: present(10) } });
  const box = boxScoreDocument({ date: '2026-01-02', status: 'final', venue: 'Arena',
    away: { name: 'B', schoolPath: '/b', score: 60, stats: line, players: [{ name: 'Q', playerPath: '/q', starter: true, stats: line, advanced: { ortg: present(100) } }] },
    home: { name: 'A', schoolPath: '/a', score: 70, stats: line } });
  Object.assign(box, { context: 'neutral', gameType: 'NCAA', description: 'East Regional' });
  box.teams[0].lineScore = [present(30), present(30)];
  box.teams[0].advanced = { pace: present(70) };
  const documents = {
    school_index: index,
    school_history: { seasons: [{ endingYear: 2026, url: 'https://x.example/a/2026.html' }, { endingYear: 2025, url: null }] },
    season,
    game_log: gameLogDocument(2026, [game]),
    box_score: box,
  };
  for (const [pageType, document] of Object.entries(documents)) {
    assertParsedDocument(pageType, document);
    assert.deepEqual(unretainedFields(DOCUMENT_FIELDS[pageType], document, retained), [], pageType);
  }
});

test('every registered production parser emits only fields the data contract lists', { skip: captureSkip(...captures) }, () => {
  const adapter = new SportsReferenceSourceAdapter();
  const registry = createProductionParserRegistry();
  assert.ok(PRODUCTION_PARSERS.length > 0);
  for (const parser of PRODUCTION_PARSERS) {
    const pageType = parser.pageType();
    const pages = captures.filter((path) => adapter.classify(captureSourceUrl(path)) === pageType);
    assert.ok(pages.length > 0, `no capture exercises the ${pageType} parser`);
    for (const path of pages) {
      const parsed = registry.parse(pageType, parser.version(), captureSnapshot(path));
      assert.equal(parsed.kind, 'valid', `${pageType} ${path}: ${parsed.error}`);
      assert.deepEqual(unretainedFields(DOCUMENT_FIELDS[pageType], parsed.document, retained), [],
        `${pageType}@${parser.version()} emits fields the data contract does not list for ${path}; add them to retainedFields and src/contracts/retained-fields.mjs`);
    }
  }
});

// The foundation corpus with an unlisted field added to every box score and
// season page. Both are allowed by the frozen shapes (`extra` objects).
function corpusWithUnlistedFields() {
  return foundationCorpus().map((entry) => {
    const match = /(<script id="fixture-document" type="application\/json">)([\s\S]*?)(<\/script>)/.exec(entry.body);
    const document = JSON.parse(match[2]);
    if (entry.url.includes('/box/')) document.extra = { broadcast: present('Network') };
    else if (document.summary) document.summary.extra = { conf_finish: present(1), preseason_poll: present(3) };
    else return entry;
    const body = entry.body.replace(match[0], `${match[1]}${JSON.stringify(document).replaceAll('<', '\\u003c')}${match[3]}`);
    return { ...entry, body };
  });
}

async function serve(app, paths) {
  const server = app.createApiServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    return Object.fromEntries(await Promise.all(paths.map(async (path) => [path, await (await fetch(`${base}${path}`)).json()])));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('a parsed document with an unlisted field is stored and served without it', async () => {
  const app = createFixtureApplication({ fixtureEntries: corpusWithUnlistedFields(), retainedFields: retained });
  const result = await app.runWorkerOnce();
  assert.ok(result.jobs.every((job) => job.state === 'parsed'));
  const pages = [...app.persistence.pages.values()];
  const games = pages.filter((page) => page.kind === 'game');
  const seasons = pages.filter((page) => page.kind === 'season');
  assert.ok(games.length > 0 && seasons.length > 0);
  for (const page of games) assert.equal('extra' in page.data, false, 'the unlisted broadcast field is not stored');
  for (const page of seasons) assert.deepEqual(page.data.summary.extra, { conf_finish: present(1) });
  const served = await serve(app, ['/games', `/games/${encodeURIComponent(games[0].identity)}`, '/seasons']);
  for (const game of [...served['/games'], served[`/games/${encodeURIComponent(games[0].identity)}`]]) {
    assert.equal('extra' in game, false);
    assert.equal(game.venue, games[0].data.venue);
  }
  for (const season of served['/seasons']) assert.deepEqual(season.summary.extra, { conf_finish: present(1) });
});

test('a field the data contract drops is neither stored nor served', async () => {
  const narrower = retained.filter((field) => field !== 'box_scores.attendance' && field !== 'seasons.coach');
  const app = createFixtureApplication({ fixtureEntries: foundationCorpus(), retainedFields: narrower });
  await app.runWorkerOnce();
  const pages = [...app.persistence.pages.values()];
  for (const page of pages.filter((entry) => entry.kind === 'game')) assert.equal('attendance' in page.data, false);
  for (const page of pages.filter((entry) => entry.kind === 'season')) assert.equal('coach' in page.data.summary, false);
  const served = await serve(app, ['/games', '/seasons']);
  assert.ok(served['/games'].length > 0);
  for (const game of served['/games']) { assert.equal('attendance' in game, false); assert.ok('venue' in game); }
  for (const season of served['/seasons']) assert.equal('coach' in season.summary, false);
});

function assertEveryFieldListed(spec, item, route) {
  const fields = fieldCategories(spec, item);
  assert.ok(fields.length > 0, route);
  for (const { path, field } of fields) {
    assert.ok(field, `${route} returns ${path}, which maps to no data-contract field`);
    assert.ok(listed.has(field), `${route} returns ${path} as ${field}, which the data contract does not list`);
  }
}

test('every field the API returns from the fixture store is in the data contract', async () => {
  const app = createFixtureApplication({ fixtureEntries: corpusWithUnlistedFields(), retainedFields: retained });
  await app.runWorkerOnce();
  const game = [...app.persistence.pages.values()].find((page) => page.kind === 'game');
  const gamePath = `/games/${encodeURIComponent(game.identity)}`;
  const served = await serve(app, ['/schools', '/seasons', '/games', gamePath, '/health']);
  for (const [route, spec] of [['/schools', API_FIELDS.school], ['/seasons', API_FIELDS.season], ['/games', API_FIELDS.game]]) {
    assert.ok(served[route].length > 0, route);
    for (const item of served[route]) assertEveryFieldListed(spec, item, route);
  }
  assertEveryFieldListed(API_FIELDS.game, served[gamePath], gamePath);
  // /health serves counts only, never source data.
  const counts = (value) => (typeof value === 'number' ? true : Object.values(value).every(counts));
  assert.ok(counts(served['/health']));
});

test('every field the API returns from PostgreSQL rows is in the data contract, including older revision data', async () => {
  const provenance = { providerId: 'p', canonicalPath: 'x', sourceFetchId: 1, parserName: 'box_score', parserVersion: '1' };
  const rows = {
    schools: [{ provider_id: 'p', canonical_source_path: 'x/a', source_url: 'https://x.example/a/', display_name: 'A', city: 'C', state: 'S',
      from_year: 1900, to_year: 2026, eligible: true, provenance, internal_id: 7 }],
    school_seasons: [{ provider_id: 'p', canonical_source_path: 'x/a', ending_year: 2026, coverage_status: 'covered', provenance }],
    games: [{ provider_id: 'p', canonical_box_score_path: 'x/box', provenance,
      data: { date: '2026-01-02', venue: 'Arena', legacyNote: 'stored before #89', extra: { broadcast: present('Network') } } }],
  };
  const pool = { on() {}, end: async () => {}, query: async (text) => {
    if (/FROM schools/.test(text) && !/school_seasons/.test(text)) return { rows: rows.schools, rowCount: 1 };
    if (/FROM school_seasons/.test(text)) return { rows: rows.school_seasons, rowCount: 1 };
    return { rows: rows.games, rowCount: 1 };
  } };
  const queries = createQueryService(new PostgresPersistence({ pool }), { retainedFields: retained });
  const [schools, seasons, games, game] = [(await queries.listSchools()).items, (await queries.listSeasons()).items,
    (await queries.listGames()).items, await queries.getGame('p:x/box')];
  assertEveryFieldListed(API_FIELDS.school, schools[0], '/schools');
  assertEveryFieldListed(API_FIELDS.season, seasons[0], '/seasons');
  for (const item of [games[0], game]) {
    assertEveryFieldListed(API_FIELDS.game, item, '/games');
    assert.deepEqual(Object.keys(item).sort(), ['date', 'gameKey', 'provenance', 'venue']);
  }
});

test('the normalizer keeps only the retained fields it is given', () => {
  const document = boxScoreDocument({ date: '2026-01-02', status: 'final', venue: 'Arena',
    away: { name: 'B', schoolPath: null, score: 60, stats: statLine({ pts: 60 }) }, home: { name: 'A', schoolPath: '/a', score: 70, stats: statLine({ pts: 70 }) } });
  const context = { jobKey: 'box', canonicalPath: 'p:x/box' };
  const everything = new Normalizer().normalize('box_score', { ...document, extra: { broadcast: present('Network') } }, context);
  assert.equal(everything.data.venue, 'Arena');
  assert.equal(everything.data.homeScore, 70);
  assert.equal('extra' in everything.data, false, 'an unmapped field is dropped even without a contract');
  const narrow = new Normalizer({ retainedFields: ['box_scores.date', 'box_scores.status'] }).normalize('box_score', document, context);
  assert.deepEqual(Object.keys(narrow.data).sort(), ['date', 'gameDate', 'status']);
  assert.deepEqual(retainFields(DOCUMENT_FIELDS.box_score, { venue: 'Arena', attendance: unavailable('x') }, ['box_scores.venue']).dropped,
    [{ path: 'attendance', field: 'box_scores.attendance' }]);
});
