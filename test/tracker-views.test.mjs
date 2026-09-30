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
const V1 = text('018_tracker_v1.sql');

const VIEWS = [
  'schools', 'seasons', 'season_team_stats', 'season_rosters', 'season_player_stats', 'game_log_rows', 'game_log_row_stats',
  'games', 'game_teams', 'team_game_stats', 'player_game_stats', 'crawl_scope', 'season_completeness',
];

// Each view's SQL, from its CREATE to the semicolon that ends it.
function definitions(sql) {
  return new Map([...sql.matchAll(/CREATE OR REPLACE VIEW tracker_v1\.(\w+) AS\n([\s\S]*?);\n/g)].map((match) => [match[1], match[2]]));
}

test('tracker_v1 defines exactly the documented views, repeat-safely', () => {
  const found = definitions(V1);
  assert.deepEqual([...found.keys()].sort(), [...VIEWS].sort());
  assert.match(V1, /CREATE SCHEMA IF NOT EXISTS tracker_v1;/);
  assert.doesNotMatch(V1, /CREATE VIEW/, 'a view is created with OR REPLACE so the migration can be applied twice');
  assert.doesNotMatch(V1, /\bDROP\b/i);
  assert.match(V1, /INSERT INTO schema_migrations\(version\) VALUES \('018_tracker_v1'\) ON CONFLICT \(version\) DO NOTHING;/);
});

test('only migration 018 may mention tracker_v1: a change to the views is a new version', () => {
  const mentioning = migrations.filter((name) => /tracker_v1/.test(text(name)));
  assert.deepEqual(mentioning, ['018_tracker_v1.sql']);
});

test('the views expose domain rows and never the crawl\'s internals', () => {
  const forbidden = [
    /provenance/i, /raw_object/i, /checksum/i, /source_fetches/i, /parse_runs/i, /authorization/i, /publication_polic/i, /in_flight/i,
    /host_request/i, /operator_dispositions/i, /run_halts/i, /raw_store/i, /reconciliation_/i, /normalized_page/i, /job_state_events/i,
    /page_observation/i, /game_observations/i, /unavailable_coverage/i, /schema_migrations/i, /lease/i,
  ];
  const allowedTables = new Set(['schools', 'school_seasons', 'team_seasons', 'team_season_stats', 'season_rosters', 'player_season_stats', 'players',
    'game_log_rows', 'game_log_row_stats', 'games', 'game_teams', 'team_game_stats', 'player_game_stats', 'crawl_scopes', 'crawl_jobs']);
  for (const [name, sql] of definitions(V1)) {
    for (const pattern of forbidden) assert.doesNotMatch(sql, pattern, `${name} mentions ${pattern}`);
    for (const [, table] of sql.matchAll(/\bpublic\.(\w+)/g)) assert.ok(allowedTables.has(table), `${name} reads public.${table}`);
    if (name !== 'season_completeness') assert.doesNotMatch(sql, /crawl_jobs/, `${name} reads job states`);
    assert.doesNotMatch(sql, /SELECT \*|\.\*/, `${name} names its columns, so a new column in a table never widens a view`);
  }
});

test('every view is keyed by the provider\'s own paths, not by database ids', () => {
  for (const [name, sql] of definitions(V1)) {
    const columns = sql.split(/\bFROM\b/)[0];
    assert.doesNotMatch(columns, /\b\w+\.id\b(?!\s*=)(?!\s+IS\b)/, `${name} exposes an internal id`);
  }
  assert.match(definitions(V1).get('schools'), /canonical_source_path AS school_path/);
  assert.match(definitions(V1).get('games'), /canonical_box_score_path AS game_path/);
});

test('season completeness is a state per season, and a settled season means parsed or failed for good', () => {
  const sql = definitions(V1).get('season_completeness');
  for (const state of ['unavailable', 'in_progress', 'complete']) assert.match(sql, new RegExp(`'${state}'`), state);
  assert.match(sql, /state IN \('parse_failed', 'permanently_failed'\)/, 'a failed page counts as settled');
  assert.doesNotMatch(sql, /operator_stop/, 'a page stopped for review is not settled');
  for (const column of ['season_parsed', 'game_log_parsed', 'box_scores_linked', 'box_scores_parsed', 'box_scores_failed', 'box_scores_pending']) {
    assert.match(sql, new RegExp(`AS ${column}`), column);
  }
  // A link whose box-score job does not exist yet still counts as pending.
  assert.match(sql, /LEFT JOIN public\.crawl_jobs/);
});

test('each version has a frozen column snapshot, and every snapshot has its views', () => {
  const versions = [...new Set(migrations.flatMap((name) => [...text(name).matchAll(/\b(tracker_v[1-9]\d*)\b/g)].map((match) => match[1])))];
  assert.deepEqual(versions, ['tracker_v1']);
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
