// `npm run grant:tracker` (#119): gives march-madness-tracker's database role read
// access to the versioned tracker views and to nothing else. Run it as the
// database owner, after the role exists (created in the Render dashboard or with
// CREATE ROLE ... LOGIN PASSWORD, never in a migration or a commit). Repeat-safe.
//
//   npm run grant:tracker                     grants tracker_readonly
//   npm run grant:tracker -- --role name      another role
//   npm run grant:tracker -- --dry-run        prints the statements only
import pg from 'pg';
import { DEFAULT_TRACKER_ROLE, TRACKER_SCHEMA, assertRoleName, grantStatements } from '../src/persistence/tracker-grants.mjs';

function fail(message, code = 1) {
  console.error(`grant:tracker failed: ${message}`);
  process.exit(code);
}

const args = process.argv.slice(2);
let role = process.env.TRACKER_ROLE || DEFAULT_TRACKER_ROLE;
let dryRun = false;
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--dry-run') dryRun = true;
  else if (args[index] === '--role' && args[index + 1]) { role = args[index + 1]; index += 1; } else fail(`argument ${args[index]} is invalid. Example: npm run grant:tracker -- --role ${DEFAULT_TRACKER_ROLE} --dry-run`, 2);
}
try { assertRoleName(role); } catch (error) { fail(error.message, 2); }
for (const name of ['PGHOST', 'PGDATABASE', 'PGUSER', 'PGPASSWORD']) {
  if (!process.env[name]) fail(`${name} is required; connection settings are never printed`, 2);
}

const client = new pg.Client();
try {
  await client.connect();
} catch (error) {
  fail(`could not connect (${error.code ?? error.message}); check PG* settings, PGSSLMODE, and the IP allow list`);
}
try {
  const found = await client.query('SELECT rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = $1', [role]);
  if (!found.rowCount) fail(`role ${role} does not exist. Create it first, with its password set in the Render dashboard, then run this again`, 2);
  const [{ rolsuper, rolcreatedb, rolcreaterole }] = found.rows;
  if (rolsuper || rolcreatedb || rolcreaterole) fail(`role ${role} can create databases or roles or is a superuser; the tracker role must be an ordinary login role`, 2);
  const schemas = (await client.query('SELECT nspname FROM pg_namespace ORDER BY nspname')).rows.map((row) => row.nspname).filter((name) => TRACKER_SCHEMA.test(name));
  if (!schemas.length) fail('no tracker_v<n> schema exists yet; run npm run migrate first', 2);
  const { current_database: database } = (await client.query('SELECT current_database()')).rows[0];
  const statements = grantStatements({ role, schemas, database });
  if (dryRun) {
    console.log(statements.join(';\n') + ';');
  } else {
    await client.query('BEGIN');
    try {
      for (const statement of statements) await client.query(statement);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      fail(error.message);
    }
    console.log(`grant:tracker passed: ${role} can read ${schemas.join(', ')} and nothing in public`);
  }
} finally {
  await client.end();
}
