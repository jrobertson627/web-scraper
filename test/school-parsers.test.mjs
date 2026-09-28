import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { IngestionOrchestrator } from '../src/application/orchestrator.mjs';
import { createJob, createSnapshot } from '../src/contracts/boundaries.mjs';
import { canonicalizeSourceUrl, createSourceUrl } from '../src/contracts/source.mjs';
import { MemoryRawStore, InMemoryPersistence } from '../src/persistence/index.mjs';
import {
  SchoolHistoryParser, SchoolIndexParser, createProductionParserRegistry, missingProductionParsers,
} from '../src/parsers/index.mjs';
import { captureSkip, captureSnapshot } from '../fixtures/sports-reference/captures.mjs';

const origin = 'https://www.sports-reference.com';
const indexStats = [
  'school_name', 'location', 'year_min', 'year_max', 'years', 'g', 'wins', 'losses', 'win_loss_pct',
  'srs', 'sos', 'poll_final', 'conf_champ_count', 'conf_champ_post_count', 'ncaa_count',
  'ncaa_final_four_count', 'ncaa_champ_count',
];

function snapshot(path, body) {
  const sourceUrl = createSourceUrl('sports-reference', `${origin}${path}`);
  return createSnapshot({
    jobKey: `test:${path}`, sourceUrl, body: Buffer.from(body),
    sourceUrlFrom: (target, baseUrl = sourceUrl.absoluteUrl) => createSourceUrl('sports-reference', target, baseUrl),
  });
}

function indexHtml() {
  const headers = indexStats.map((stat) => `<th data-stat="${stat}">${stat}</th>`).join('');
  const values = {
    school_name: '<a href="/cbb/schools/duke/men/">Duke Blue Devils</a>', location: 'Durham, North Carolina',
    year_min: '1906', year_max: '2026', years: '121', g: '3,306', wins: '2370', losses: '936',
    win_loss_pct: '.717', srs: '', sos: '6.86', poll_final: '54', conf_champ_count: '25',
    conf_champ_post_count: '29', ncaa_count: '48', ncaa_final_four_count: '18', ncaa_champ_count: '5',
  };
  const cells = indexStats.map((stat) => `<td data-stat="${stat}">${values[stat]}</td>`).join('');
  return `<table id="NCAAM_schools"><thead><tr>${headers}</tr></thead><tbody><tr>${cells}</tr></tbody></table>`;
}

test('school_index@1 emits the frozen school shape and preserves blank aggregate values', () => {
  const parsed = createProductionParserRegistry().parse('school_index', '1', snapshot('/cbb/schools/', indexHtml()));
  assert.equal(parsed.kind, 'valid');
  assert.deepEqual(parsed.document.schools[0], {
    name: 'Duke Blue Devils', path: '/cbb/schools/duke/men/', historyUrl: `${origin}/cbb/schools/duke/men/`,
    city: 'Durham', state: 'North Carolina', from: 1906, to: 2026,
    aggregateFields: {
      years: { state: 'present', value: 121 }, g: { state: 'present', value: 3306 },
      wins: { state: 'present', value: 2370 }, losses: { state: 'present', value: 936 },
      win_loss_pct: { state: 'present', value: 0.717 }, srs: { state: 'blank' }, sos: { state: 'present', value: 6.86 },
      poll_final: { state: 'present', value: 54 }, conf_champ_count: { state: 'present', value: 25 },
      conf_champ_post_count: { state: 'present', value: 29 }, ncaa_count: { state: 'present', value: 48 },
      ncaa_final_four_count: { state: 'present', value: 18 }, ncaa_champ_count: { state: 'present', value: 5 },
    },
  });
});

test('school_history@1 reads a commented table and retains only linked target years', () => {
  const html = `<!-- <table id="duke"><thead><tr><th data-stat="season">Season</th></tr></thead><tbody>
    <tr><th data-stat="season"><a href="/cbb/schools/duke/men/2026.html">2025-26</a></th></tr>
    <tr><th data-stat="season"><a href="/cbb/schools/duke/men/2021.html">2020-21</a></th></tr>
    <tr><th data-stat="season">2024-25</th></tr></tbody></table> -->`;
  const parsed = createProductionParserRegistry().parse('school_history', '1', snapshot('/cbb/schools/duke/men/', html));
  assert.deepEqual(parsed, {
    kind: 'valid', warnings: [],
    document: { seasons: [{ endingYear: 2026, url: `${origin}/cbb/schools/duke/men/2026.html` }] },
  });
});

test('school parsers fail closed on layout-shift fixtures', () => {
  const fixtures = [
    [new SchoolIndexParser(), '/cbb/schools/', 'school-index-layout-shift.html', /year_max column/],
    [new SchoolHistoryParser(), '/cbb/schools/duke/men/', 'school-history-layout-shift.html', /season column/],
  ];
  for (const [parser, path, file, expected] of fixtures) {
    const body = readFileSync(new URL(`fixtures/sports-reference/${file}`, import.meta.url));
    const parsed = parser.parse(snapshot(path, body));
    assert.equal(parser.version(), '1');
    assert.equal(parsed.kind, 'structural_failure');
    assert.match(parsed.error, expected);
  }
});

test('a school layout shift is persisted as parse_failed with parser version and failure details', async () => {
  const now = new Date('2026-09-27T00:00:00Z');
  const clock = () => now;
  const rawStore = new MemoryRawStore();
  const body = readFileSync(new URL('fixtures/sports-reference/school-index-layout-shift.html', import.meta.url));
  const raw = rawStore.put(body);
  const persistence = new InMemoryPersistence(clock);
  const sourceUrl = createSourceUrl('sports-reference', `${origin}/cbb/schools/`);
  persistence.addJob(createJob({
    key: 'shifted-index', pageType: 'school_index', sourceUrl,
    canonicalPath: canonicalizeSourceUrl(sourceUrl), parserVersion: '1',
  }));
  const orchestrator = new IngestionOrchestrator({
    fetcher: { fetch: async () => ({ kind: 'fetched', sourceFetchId: 'fetch-shifted', checksum: raw.checksum }) },
    parsers: createProductionParserRegistry(), persistence, rawStore, clock,
  });
  const result = await orchestrator.runOnce('parser-test');
  assert.equal(result.events[0].kind, 'parse_failed');
  assert.equal(persistence.getJob('shifted-index').state, 'parse_failed');
  assert.deepEqual(persistence.parseRuns.map(({ parserName, parserVersion, status }) => ({ parserName, parserVersion, status })), [
    { parserName: 'school_index', parserVersion: '1', status: 'structural_failure' },
  ]);
  assert.match(persistence.parseRuns[0].failureDetails.error, /year_max column/);
});

test('real school captures parse into exact frozen documents', {
  skip: captureSkip('/cbb/schools/', '/cbb/schools/duke/men/', '/cbb/schools/le-moyne/men/'),
}, () => {
  const registry = createProductionParserRegistry();
  const index = registry.parse('school_index', '1', captureSnapshot('/cbb/schools/'));
  assert.equal(index.kind, 'valid');
  assert.equal(index.document.schools.length, 495);
  const duke = index.document.schools.find((school) => school.path === '/cbb/schools/duke/men/');
  assert.deepEqual({ name: duke.name, city: duke.city, state: duke.state, from: duke.from, to: duke.to },
    { name: 'Duke Blue Devils', city: 'Durham', state: 'North Carolina', from: 1906, to: 2026 });
  assert.deepEqual(duke.aggregateFields.ncaa_champ_count, { state: 'present', value: 5 });
  assert.ok(index.document.schools.some((school) => school.aggregateFields.srs.state === 'blank'));

  for (const [slug, years] of [['duke', [2026, 2025, 2024, 2023, 2022]], ['le-moyne', [2026, 2025, 2024]]]) {
    const history = registry.parse('school_history', '1', captureSnapshot(`/cbb/schools/${slug}/men/`));
    assert.equal(history.kind, 'valid');
    assert.deepEqual(history.document.seasons.map((season) => season.endingYear), years);
    assert.ok(history.document.seasons.every((season) => season.url === `${origin}/cbb/schools/${slug}/men/${season.endingYear}.html`));
  }
});

test('the production registry reports box_score as the only parser still missing', () => {
  const versions = Object.fromEntries(['school_index', 'school_history', 'season', 'game_log', 'box_score'].map((type) => [type, '1']));
  assert.deepEqual(missingProductionParsers(createProductionParserRegistry(), versions), ['box_score@1']);
});
