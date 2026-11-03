import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_TRACKER_ROLE, TRACKER_SCHEMA, assertRoleName, grantStatements } from '../src/persistence/tracker-grants.mjs';

// #119, #132: the tracker reads versioned views, not tables. These checks run
// without a database; the PostgreSQL suite compares the real columns to the
// snapshot in fixtures/tracker/.

const root = process.cwd();
const migrations = readdirSync(join(root, 'migrations')).filter((name) => /^\d{3}_.+\.sql$/.test(name)).sort();
const text = (name) => readFileSync(join(root, 'migrations', name), 'utf8').replaceAll('\r\n', '\n');
// [schema, migration SQL, migration version]
const VERSIONS = [
  ['tracker_v1', text('018_tracker_v1.sql'), '018_tracker_v1'],
  ['tracker_v2', text('022_tracker_v2.sql'), '022_tracker_v2'],
];
const [[, V1], [, V2]] = VERSIONS;

const VIEWS = [
  'schools', 'seasons', 'season_team_stats', 'season_rosters', 'season_player_stats', 'game_log_rows', 'game_log_row_stats',
  'games', 'game_teams', 'team_game_stats', 'player_game_stats', 'crawl_scope', 'season_completeness',
];

// Each view's SQL, from its CREATE to the semicolon that ends it.
function definitions(sql, schema = 'tracker_v1') {
  return new Map([...sql.matchAll(new RegExp(`CREATE OR REPLACE VIEW ${schema}\\.(\\w+) AS\\n([\\s\\S]*?);\\n`, 'g'))].map((match) => [match[1], match[2]]));
}

// Every definition of every version, as [schema.view, SQL].
function allDefinitions() {
  return VERSIONS.flatMap(([schema, sql]) => [...definitions(sql, schema)].map(([name, definition]) => [`${schema}.${name}`, definition]));
}

test('each tracker version defines exactly the documented views, repeat-safely', () => {
  for (const [schema, sql, migration] of VERSIONS) {
    assert.deepEqual([...definitions(sql, schema).keys()].sort(), [...VIEWS].sort(), schema);
    assert.match(sql, new RegExp(`CREATE SCHEMA IF NOT EXISTS ${schema};`));
    assert.doesNotMatch(sql, /CREATE VIEW/, 'a view is created with OR REPLACE so the migration can be applied twice');
    assert.doesNotMatch(sql, /\bDROP\b/i);
    assert.match(sql, new RegExp(`INSERT INTO schema_migrations\\(version\\) VALUES \\('${migration}'\\) ON CONFLICT \\(version\\) DO NOTHING;`));
  }
});

test('only a version\'s own migration may mention it: a change to the views is a new version', () => {
  for (const [schema, , migration] of VERSIONS) {
    assert.deepEqual(migrations.filter((name) => text(name).includes(schema)), [`${migration}.sql`], schema);
  }
});

test('tracker_v2 is tracker_v1 plus the roster\'s hometown and high school, and nothing else', () => {
  const one = definitions(V1, 'tracker_v1');
  const two = definitions(V2, 'tracker_v2');
  for (const view of VIEWS.filter((name) => name !== 'season_rosters')) {
    assert.equal(two.get(view), one.get(view).replaceAll('tracker_v1', 'tracker_v2'), `${view} is unchanged`);
  }
  assert.match(two.get('season_rosters'), /r\.weight, r\.hometown, r\.high_school, r\.value_states/);
  assert.equal(two.get('season_rosters').replace('r.hometown, r.high_school, ', '').replace('tracker_v2', 'tracker_v1'), one.get('season_rosters'));
  const frozen = (schema) => JSON.parse(readFileSync(join(root, 'fixtures', 'tracker', `${schema}.json`), 'utf8'));
  const [before, after] = [frozen('tracker_v1'), frozen('tracker_v2')];
  for (const view of VIEWS.filter((name) => name !== 'season_rosters')) assert.deepEqual(after[view], before[view], view);
  assert.deepEqual(after.season_rosters.filter((column) => !before.season_rosters.some((old) => old.name === column.name)),
    [{ name: 'hometown', type: 'text' }, { name: 'high_school', type: 'text' }]);
  assert.deepEqual(before.season_rosters.map((column) => column.name), after.season_rosters.map((column) => column.name)
    .filter((name) => name !== 'hometown' && name !== 'high_school'), 'the other columns keep their order');
});

test('migration 021 adds the columns and fills them from stored rows, repeat-safely', () => {
  const sql = text('021_roster_hometown_high_school.sql');
  assert.match(sql, /ADD COLUMN IF NOT EXISTS hometown TEXT/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS high_school TEXT/);
  assert.doesNotMatch(sql, /\bDROP\b|DELETE FROM/i, 'extra is kept, so nothing is lost');
  assert.match(sql, /UPDATE season_rosters SET/);
  assert.match(sql, /INSERT INTO schema_migrations\(version\) VALUES \('021_roster_hometown_high_school'\) ON CONFLICT \(version\) DO NOTHING;/);
});

test('a version created after migration 020 repeats its revoke of the Supabase API roles', () => {
  assert.match(V2, /rolname IN \('anon', 'authenticated'\)/);
  for (const statement of ['REVOKE ALL ON SCHEMA tracker_v2', 'REVOKE ALL ON ALL TABLES IN SCHEMA tracker_v2', 'ALTER DEFAULT PRIVILEGES IN SCHEMA tracker_v2 REVOKE ALL ON TABLES']) {
    assert.ok(V2.includes(statement), statement);
  }
});

test('the views expose domain rows and never the crawl\'s internals', () => {
  const forbidden = [
    /provenance/i, /raw_object/i, /checksum/i, /source_fetches/i, /parse_runs/i, /authorization/i, /publication_polic/i, /in_flight/i,
    /host_request/i, /operator_dispositions/i, /run_halts/i, /raw_store/i, /reconciliation_/i, /normalized_page/i, /job_state_events/i,
    /page_observation/i, /game_observations/i, /unavailable_coverage/i, /schema_migrations/i, /lease/i,
  ];
  const allowedTables = new Set(['schools', 'school_seasons', 'team_seasons', 'team_season_stats', 'season_rosters', 'player_season_stats', 'players',
    'game_log_rows', 'game_log_row_stats', 'games', 'game_teams', 'team_game_stats', 'player_game_stats', 'crawl_scopes', 'crawl_jobs']);
  for (const [name, sql] of allDefinitions()) {
    for (const pattern of forbidden) assert.doesNotMatch(sql, pattern, `${name} mentions ${pattern}`);
    assert.doesNotMatch(sql, /\bextra\b/, `${name} leaves the parser's extra values out`);
    for (const [, table] of sql.matchAll(/\bpublic\.(\w+)/g)) assert.ok(allowedTables.has(table), `${name} reads public.${table}`);
    if (!name.endsWith('.season_completeness')) assert.doesNotMatch(sql, /crawl_jobs/, `${name} reads job states`);
    assert.doesNotMatch(sql, /SELECT \*|\.\*/, `${name} names its columns, so a new column in a table never widens a view`);
  }
});

test('every view is keyed by the provider\'s own paths, not by database ids', () => {
  for (const [name, sql] of allDefinitions()) {
    const columns = sql.split(/\bFROM\b/)[0];
    assert.doesNotMatch(columns, /\b\w+\.id\b(?!\s*=)(?!\s+IS\b)/, `${name} exposes an internal id`);
  }
  for (const [schema, migration] of VERSIONS) {
    assert.match(definitions(migration, schema).get('schools'), /canonical_source_path AS school_path/);
    assert.match(definitions(migration, schema).get('games'), /canonical_box_score_path AS game_path/);
  }
});

test('season completeness is a state per season, and a settled season means parsed or failed for good', () => {
  for (const [schema, migration] of VERSIONS) {
    const sql = definitions(migration, schema).get('season_completeness');
    for (const state of ['unavailable', 'in_progress', 'complete']) assert.match(sql, new RegExp(`'${state}'`), state);
    assert.match(sql, /state IN \('parse_failed', 'permanently_failed'\)/, 'a failed page counts as settled');
    assert.doesNotMatch(sql, /operator_stop/, 'a page stopped for review is not settled');
    for (const column of ['season_parsed', 'game_log_parsed', 'box_scores_linked', 'box_scores_parsed', 'box_scores_failed', 'box_scores_pending']) {
      assert.match(sql, new RegExp(`AS ${column}`), column);
    }
    // A link whose box-score job does not exist yet still counts as pending.
    assert.match(sql, /LEFT JOIN public\.crawl_jobs/);
  }
});

test('each version has a frozen column snapshot, and every snapshot has its views', () => {
  const versions = [...new Set(migrations.flatMap((name) => [...text(name).matchAll(/\b(tracker_v[1-9]\d*)\b/g)].map((match) => match[1])))];
  assert.deepEqual(versions, ['tracker_v1', 'tracker_v2']);
  for (const version of versions) {
    const file = join(root, 'fixtures', 'tracker', `${version}.json`);
    assert.ok(existsSync(file), `${version} needs fixtures/tracker/${version}.json`);
    const snapshot = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(Object.keys(snapshot).sort(), [...VIEWS].sort(), 'the snapshot names every view');
    for (const [view, columns] of Object.entries(snapshot)) {
      assert.ok(columns.length > 0, `${view} has columns`);
      assert.ok(columns.every((column) => typeof column.name === 'string' && typeof column.type === 'string'), view);
    }
  }
});

test('the tracker role is granted the versioned schemas and nothing in public', () => {
  const statements = grantStatements({ role: DEFAULT_TRACKER_ROLE, schemas: ['tracker_v1'], database: 'scraper' });
  assert.deepEqual(statements, [
    'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM "tracker_readonly"',
    'REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM "tracker_readonly"',
    'REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM "tracker_readonly"',
    'REVOKE CREATE ON SCHEMA public FROM "tracker_readonly"',
    'GRANT CONNECT ON DATABASE "scraper" TO "tracker_readonly"',
    'GRANT USAGE ON SCHEMA "tracker_v1" TO "tracker_readonly"',
    'GRANT SELECT ON ALL TABLES IN SCHEMA "tracker_v1" TO "tracker_readonly"',
    'ALTER DEFAULT PRIVILEGES IN SCHEMA "tracker_v1" GRANT SELECT ON TABLES TO "tracker_readonly"',
  ]);
  assert.ok(!statements.some((statement) => /^GRANT .* public/.test(statement)), 'nothing is granted in public');
  const both = grantStatements({ role: 'tracker', schemas: ['tracker_v1', 'tracker_v2'], database: 'db' });
  assert.equal(both.filter((statement) => statement.startsWith('GRANT USAGE')).length, 2, 'a new version is granted alongside the old');
});

test('role and schema names are validated, so nothing else can be granted', () => {
  assert.equal(assertRoleName('tracker_readonly'), 'tracker_readonly');
  for (const bad of ['', 'Tracker', 'tracker; DROP', 'tracker-ro', 'a'.repeat(64), undefined, 'x"y']) assert.throws(() => assertRoleName(bad), /role name .* is invalid/, String(bad));
  for (const schema of ['public', 'tracker_v0', 'tracker_v', 'tracker', 'pg_catalog', 'tracker_v1; DROP']) {
    assert.equal(TRACKER_SCHEMA.test(schema), false, schema);
    assert.throws(() => grantStatements({ role: 'r', schemas: [schema], database: 'd' }), /tracker_v<n> schemas only/, schema);
  }
  assert.throws(() => grantStatements({ role: 'r', schemas: [], database: 'd' }), /tracker_v<n> schemas only/);
  assert.throws(() => grantStatements({ role: 'r', schemas: ['tracker_v1'], database: '' }), /database name/);
  assert.equal(grantStatements({ role: 'r', schemas: ['tracker_v1'], database: 'a"b' }).find((statement) => statement.startsWith('GRANT CONNECT')), 'GRANT CONNECT ON DATABASE "a""b" TO "r"');
});

test('provisioning grants the views, not the tables', () => {
  const deployment = readFileSync(join(root, 'DEPLOYMENT.md'), 'utf8');
  assert.match(deployment, /npm run grant:tracker/);
  assert.doesNotMatch(deployment, /GRANT SELECT ON ALL TABLES IN SCHEMA public/, 'no blanket table grant');
  assert.doesNotMatch(deployment, /ALTER DEFAULT PRIVILEGES IN SCHEMA public/);
});
