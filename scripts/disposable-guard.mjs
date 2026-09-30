// Guards for the scripts that write to or truncate a PostgreSQL database
// (test:postgres, the ops integration suite and smoke:migrations, #121).
//
// The per-command *_CONFIRM variable says the operator meant it. It is not
// enough alone: a .env filled in with production connection values would satisfy
// it, and the truncate cannot be undone. So a script also refuses unless the
// database looks disposable:
//
//   - PGHOST is a local host (or a unix socket directory), and
//   - the database holds no crawl data, unless a previous run of these
//     scripts marked it as a test database.
//
// PG_DESTRUCTIVE_OVERRIDE, set to the database's own name, skips both checks.
// It exists for a deliberate run against a private throwaway server and is
// never set by any script or template here.
//
// Messages name the variable that failed, never the host, user or database.

export const DISPOSABLE_MARKER_TABLE = 'disposable_test_marker';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function isLocalHost(host) {
  if (typeof host !== 'string' || !host) return false;
  const name = host.toLowerCase();
  return LOCAL_HOSTS.has(name) || name.endsWith('.localhost') || name.startsWith('/');
}

// The reason a database must not be written to, or null when it may be.
// hasRows and hasMarker describe the database: crawl_jobs holds rows, and the
// marker table left by an earlier test run exists.
export function disposabilityProblem({ host, database, override, hasRows, hasMarker }) {
  if (override && override === database) return null;
  if (!isLocalHost(host)) {
    return 'PGHOST is not a local host. These scripts create and delete tables; run them against a local or CI database, never a hosted one';
  }
  if (hasRows && !hasMarker) {
    return 'the database already holds crawl data and was not created by these test scripts. Use an empty database';
  }
  return null;
}

// query(sql) resolves to an array of row objects. Throws when the database is
// not disposable; otherwise marks it as a test database when `mark` is set.
export async function assertDisposableDatabase(query, env = process.env, { mark = false } = {}) {
  const [state] = await query(`SELECT to_regclass('public.crawl_jobs') IS NOT NULL AS has_jobs,
    to_regclass('public.${DISPOSABLE_MARKER_TABLE}') IS NOT NULL AS has_marker`);
  const hasRows = state.has_jobs ? (await query('SELECT EXISTS (SELECT 1 FROM crawl_jobs) AS present'))[0].present : false;
  const problem = disposabilityProblem({
    host: env.PGHOST, database: env.PGDATABASE, override: env.PG_DESTRUCTIVE_OVERRIDE, hasRows, hasMarker: state.has_marker,
  });
  if (problem) throw new Error(`refusing to continue: ${problem}`);
  if (mark && !state.has_marker) {
    // Modules that share a database mark it as they load, in parallel; two
    // CREATE TABLE IF NOT EXISTS can still collide, and losing is fine.
    try {
      await query(`CREATE TABLE IF NOT EXISTS ${DISPOSABLE_MARKER_TABLE} (marked_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    } catch (error) {
      if (!['42P07', '23505', '42710'].includes(error?.code)) throw error;
    }
  }
}
