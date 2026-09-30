// PostgreSQL-level checks for the tracker interface (#119, #132). Imported by
// postgres-integration.mjs so `npm run test:postgres` runs them against the same
// explicitly disposable database; never run on its own.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { PostgresPersistence } from '../src/persistence/postgres.mjs';
import { createRawStore } from '../src/persistence/index.mjs';
import { createFixtureApplication } from '../src/application/composition-root.mjs';
import { foundationCorpus } from '../fixtures/foundation-corpus.mjs';
import { grantStatements } from '../src/persistence/tracker-grants.mjs';
import { assertDisposableDatabase } from './disposable-guard.mjs';

if (process.env.PG_TEST_CONFIRM !== 'disposable' || !process.env.PGHOST || !process.env.PGDATABASE || !process.env.PGUSER) {
  throw new Error('PostgreSQL integration tests require an explicitly disposable PG* database');
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const client = new pg.Client();
await client.connect();
await assertDisposableDatabase(async (sql) => (await client.query(sql)).rows, process.env, { mark: true });
after(async () => { await client.end(); });
mkdirSync(join(process.cwd(), '.tmp'), { recursive: true });
const localRoot = mkdtempSync(join(process.cwd(), '.tmp', 'postgres-tracker-'));

async function reset() {
  const tables = await client.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`);
  const names = tables.rows.map((row) => `"${row.tablename.replaceAll('"', '""')}"`);
  if (names.length) await client.query(`TRUNCATE ${names.join(',')} RESTART IDENTITY CASCADE`);
}

async function liveColumns(schema) {
  const { rows } = await client.query(`SELECT c.relname AS view, a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_attribute a ON a.attrelid = c.oid
    WHERE n.nspname = $1 AND c.relkind = 'v' AND a.attnum > 0 AND NOT a.attisdropped ORDER BY c.relname, a.attnum`, [schema]);
  const columns = {};
  for (const row of rows) (columns[row.view] ??= []).push({ name: row.name, type: row.type });
  return columns;
}

test('every tracker schema has exactly its frozen columns, and every snapshot has its schema', async () => {
  const schemas = (await client.query(`SELECT nspname FROM pg_namespace WHERE nspname ~ '^tracker_v[1-9][0-9]*$' ORDER BY nspname`)).rows.map((row) => row.nspname);
  const snapshots = readdirSync(join(root, 'fixtures', 'tracker')).filter((name) => /^tracker_v[1-9]\d*\.json$/.test(name)).map((name) => name.slice(0, -5)).sort();
  assert.deepEqual(schemas, snapshots, 'each tracker_v<n> schema has a snapshot in fixtures/tracker/, and each snapshot a schema');
  assert.ok(schemas.length > 0);
  for (const schema of schemas) {
    const frozen = JSON.parse(readFileSync(join(root, 'fixtures', 'tracker', `${schema}.json`), 'utf8'));
    const live = await liveColumns(schema);
    assert.deepEqual(live, frozen, `${schema} changed shape. A change to a view's columns is a new version (TRACKER_INTERFACE.md, "Changing an interface"). Live columns:\n${JSON.stringify(live, null, 2)}`);
  }
});

test('the tracker role reads the views and nothing else', async (t) => {
  const { rows: [me] } = await client.query('SELECT rolsuper FROM pg_roles WHERE rolname = current_user');
  if (!me.rolsuper) { t.skip('creating a role needs a superuser'); return; }
  const role = 'tracker_ci_reader';
  const schemas = (await client.query(`SELECT nspname FROM pg_namespace WHERE nspname ~ '^tracker_v[1-9][0-9]*$'`)).rows.map((row) => row.nspname);
  await client.query(`DROP OWNED BY ${role}`).catch(() => {});
  await client.query(`DROP ROLE IF EXISTS ${role}`);
  await client.query(`CREATE ROLE ${role} LOGIN`);
  try {
    // Blanket grants of the kind the old provisioning notes described are undone by the script's statements.
    await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${role}`);
    for (const statement of grantStatements({ role, schemas, database: process.env.PGDATABASE })) await client.query(statement);
    await client.query(`SET ROLE ${role}`);
    try {
      assert.equal((await client.query('SELECT count(*)::int AS n FROM tracker_v1.schools')).rows[0].n >= 0, true, 'the views can be read');
      assert.equal((await client.query('SELECT count(*)::int AS n FROM tracker_v1.season_completeness')).rows[0].n >= 0, true);
      for (const table of ['schools', 'games', 'source_fetches', 'crawl_jobs', 'schema_migrations', 'run_halts', 'raw_store_identity']) {
        await assert.rejects(client.query(`SELECT * FROM public.${table}`), (error) => error.code === '42501', `public.${table} is not readable`);
      }
      await assert.rejects(client.query(`INSERT INTO tracker_v1.games (game_path) VALUES ('x')`), (error) => ['42501', '55000'].includes(error.code), 'a view is not writable');
      await assert.rejects(client.query(`CREATE TABLE public.tracker_ci_x (id int)`), (error) => error.code === '42501', 'it cannot create anything');
      await assert.rejects(client.query('CREATE TABLE tracker_v1.tracker_ci_x (id int)'), (error) => error.code === '42501');
    } finally { await client.query('RESET ROLE'); }
    // Running the script again changes nothing.
    for (const statement of grantStatements({ role, schemas, database: process.env.PGDATABASE })) await client.query(statement);
  } finally {
    await client.query('RESET ROLE').catch(() => {});
    await client.query(`DROP OWNED BY ${role}`);
    await client.query(`DROP ROLE ${role}`);
  }
});

test('the views carry a crawled store, one row per row, and say which seasons have settled', async () => {
  await reset();
  const pool = new pg.Pool({ max: 4 });
  try {
    const persistence = new PostgresPersistence({ pool, claimTimeoutMs: 30_000 });
    const raw = createRawStore('filesystem', join(localRoot, 'raw-tracker'));
    const app = createFixtureApplication({ fixtureEntries: foundationCorpus(), sharedState: { persistence, rawStore: raw } });
    const count = async (sql) => (await client.query(sql)).rows[0].n;
    const completeness = async () => (await client.query('SELECT school_path, ending_year, state, box_scores_linked, box_scores_pending FROM tracker_v1.season_completeness ORDER BY school_path, ending_year')).rows;

    // Everything up to and including the game logs: the seasons exist, but no box score has arrived.
    await app.runWorkerOnce('tracker-worker', { pageTypes: ['school_index', 'school_history', 'season', 'game_log'] });
    const partial = await completeness();
    assert.ok(partial.length > 0);
    assert.ok(partial.some((row) => row.state === 'in_progress'), `mid-crawl seasons are in progress: ${JSON.stringify(partial)}`);
    assert.ok(partial.every((row) => ['in_progress', 'unavailable'].includes(row.state)), 'and none is complete');
    assert.ok(partial.some((row) => Number(row.box_scores_pending) > 0), 'box scores are pending');
    assert.equal(await count(`SELECT count(*)::int AS n FROM tracker_v1.season_completeness WHERE state = 'complete'`), 0, 'a reader can list only settled seasons, and there are none yet');
    assert.equal((await client.query('SELECT kind FROM tracker_v1.crawl_scope')).rows[0]?.kind, 'full', 'the scope the store was crawled under is readable');

    // The rest of the crawl.
    await app.runWorkerOnce('tracker-worker');
    const done = await completeness();
    assert.ok(done.every((row) => ['complete', 'unavailable'].includes(row.state)), `every season has settled: ${JSON.stringify(done)}`);
    assert.ok(done.some((row) => row.state === 'complete'), 'and some are complete');
    assert.ok(done.every((row) => Number(row.box_scores_pending) === 0));
    assert.equal(await count(`SELECT count(*)::int AS n FROM tracker_v1.season_completeness WHERE state = 'complete'`), done.filter((row) => row.state === 'complete').length);

    // The one-to-one views lose no row to their joins.
    for (const [view, table] of [
      ['schools', 'schools'], ['seasons', 'school_seasons'], ['season_team_stats', 'team_season_stats'], ['season_rosters', 'season_rosters'],
      ['season_player_stats', 'player_season_stats'], ['game_log_rows', 'game_log_rows'], ['game_log_row_stats', 'game_log_row_stats'],
      ['games', 'games'], ['game_teams', 'game_teams'], ['team_game_stats', 'team_game_stats'], ['player_game_stats', 'player_game_stats'],
    ]) {
      assert.equal(await count(`SELECT count(*)::int AS n FROM tracker_v1.${view}`), await count(`SELECT count(*)::int AS n FROM public.${table}`), `${view} has a row for every ${table} row`);
    }
    assert.ok(await count('SELECT count(*)::int AS n FROM tracker_v1.games') > 0, 'the crawl stored games');
    // Keyed by paths, not ids: a game joins to its game log row by path.
    assert.ok(await count('SELECT count(*)::int AS n FROM tracker_v1.game_log_rows r JOIN tracker_v1.games g ON g.game_path = r.game_path') > 0);
  } finally { await pool.end(); }
  await reset();
});

test('the views hold nothing that is not in the data contract', async () => {
  const live = { ...(await liveColumns('tracker_v1')) };
  const names = Object.values(live).flat().map((column) => column.name);
  for (const forbidden of ['provenance', 'checksum', 'raw_object_path', 'lease_generation', 'claim_owner', 'store_id', 'extra']) {
    assert.ok(!names.includes(forbidden), `no view exposes ${forbidden}`);
  }
  assert.ok(existsSync(join(root, 'TRACKER_INTERFACE.md')));
});
