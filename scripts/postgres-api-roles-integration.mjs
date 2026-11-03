// PostgreSQL-level checks for migration 020, which keeps the Supabase API roles
// (`anon`, `authenticated`) out of the database (#158). Imported by
// postgres-integration.mjs so `npm run test:postgres` runs them against the same
// explicitly disposable database; never run on its own.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { grantStatements } from '../src/persistence/tracker-grants.mjs';
import { assertDisposableDatabase } from './disposable-guard.mjs';

if (process.env.PG_TEST_CONFIRM !== 'disposable' || !process.env.PGHOST || !process.env.PGDATABASE || !process.env.PGUSER) {
  throw new Error('PostgreSQL integration tests require an explicitly disposable PG* database');
}

const client = new pg.Client();
await client.connect();
await assertDisposableDatabase(async (sql) => (await client.query(sql)).rows, process.env, { mark: true });
after(async () => { await client.end(); });

const migration = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations', '020_revoke_api_roles.sql'), 'utf8');
const API_ROLES = ['anon', 'authenticated'];
const READER = 'api_roles_ci_reader';

const trackerSchemas = async () => (await client.query(`SELECT nspname FROM pg_namespace WHERE nspname ~ '^tracker_v[1-9][0-9]*$' ORDER BY nspname`)).rows.map((row) => row.nspname);
const publicTables = async () => (await client.query(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') ORDER BY c.relname`)).rows;
const roleExists = async (name) => (await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [name])).rowCount > 0;
const mayRead = async (role, relation) => (await client.query('SELECT has_table_privilege($1, $2, $3) AS ok', [role, relation, 'SELECT'])).rows[0].ok;

test('without the Supabase API roles the migration changes nothing', async () => {
  for (const role of API_ROLES) assert.equal(await roleExists(role), false, `${role} does not exist in this database`);
  const before = await publicTables();
  await client.query(migration);
  await client.query(migration);
  assert.deepEqual(await publicTables(), before, 'no table was touched');
  assert.ok(before.every((table) => !table.relrowsecurity), 'row-level security stays off where the API roles do not exist');
});

test('with the API roles present, the migration revokes their access and turns on row-level security', async (t) => {
  const { rows: [me] } = await client.query('SELECT rolsuper FROM pg_roles WHERE rolname = current_user');
  if (!me.rolsuper) { t.skip('creating a role needs a superuser'); return; }
  if (await roleExists('anon') || await roleExists('authenticated')) { t.skip('the database already has API roles; refusing to drop them'); return; }
  const schemas = await trackerSchemas();
  assert.ok(schemas.length > 0);
  const roles = API_ROLES.join(', ');
  for (const role of API_ROLES) await client.query(`CREATE ROLE ${role} NOLOGIN`);
  await client.query(`DROP OWNED BY ${READER}`).catch(() => {});
  await client.query(`DROP ROLE IF EXISTS ${READER}`);
  await client.query(`CREATE ROLE ${READER} LOGIN`);
  try {
    // What Supabase gives these roles on a new project.
    await client.query(`GRANT USAGE ON SCHEMA public TO ${roles}`);
    await client.query(`GRANT ALL ON ALL TABLES IN SCHEMA public TO ${roles}`);
    await client.query(`GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO ${roles}`);
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO ${roles}`);
    for (const schema of schemas) {
      await client.query(`GRANT USAGE ON SCHEMA "${schema}" TO ${roles}`);
      await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA "${schema}" TO ${roles}`);
    }
    assert.equal(await mayRead('anon', 'public.schools'), true, 'the setup leaves anon able to read, as Supabase does');

    await client.query(migration);

    const tables = await publicTables();
    assert.ok(tables.length > 0);
    for (const role of API_ROLES) {
      for (const table of tables) assert.equal(await mayRead(role, `public."${table.relname}"`), false, `${role} cannot read public.${table.relname}`);
      for (const schema of schemas) {
        const { rows: [{ usage }] } = await client.query('SELECT has_schema_privilege($1, $2, $3) AS usage', [role, schema, 'USAGE']);
        assert.equal(usage, false, `${role} has no access to ${schema}`);
        const views = (await client.query(`SELECT table_name FROM information_schema.views WHERE table_schema = $1`, [schema])).rows;
        assert.ok(views.length > 0);
        for (const view of views) assert.equal(await mayRead(role, `"${schema}"."${view.table_name}"`), false, `${role} cannot read ${schema}.${view.table_name}`);
      }
    }
    assert.ok(tables.every((table) => table.relrowsecurity), 'every table in public has row-level security');
    assert.ok(tables.every((table) => !table.relforcerowsecurity), 'but not forced, so the owning role still reads and writes');

    // A table created later is not exposed by default.
    await client.query('CREATE TABLE public.api_roles_ci_later (id int)');
    try {
      for (const role of API_ROLES) assert.equal(await mayRead(role, 'public.api_roles_ci_later'), false, `${role} cannot read a table created afterwards`);
    } finally { await client.query('DROP TABLE public.api_roles_ci_later'); }

    // Running it again changes nothing.
    await client.query(migration);
    assert.deepEqual(await publicTables(), tables);

    // The tracker's role still reads its views, with row-level security on the tables behind them.
    for (const statement of grantStatements({ role: READER, schemas, database: process.env.PGDATABASE })) await client.query(statement);
    await client.query(`SET ROLE ${READER}`);
    try {
      for (const schema of schemas) assert.equal((await client.query(`SELECT count(*)::int AS n FROM "${schema}".schools`)).rows[0].n >= 0, true, `${schema} can still be read`);
    } finally { await client.query('RESET ROLE'); }
  } finally {
    await client.query('RESET ROLE').catch(() => {});
    // Leave the database as the other tests expect it.
    for (const table of await publicTables()) await client.query(`ALTER TABLE public."${table.relname}" DISABLE ROW LEVEL SECURITY`);
    await client.query(`DROP OWNED BY ${roles}, ${READER}`);
    await client.query(`DROP ROLE ${roles}, ${READER}`);
  }
});
