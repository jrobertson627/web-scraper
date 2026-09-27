// Runtime persistence selection for the api and worker modes. Postgres is
// opt-in (PERSISTENCE=postgres) so copying .env.example, which carries PG*
// placeholders, never silently points a process at a database. Local mode
// always stays in memory.

export const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000;

const SSL_MODES = new Map([
  ['disable', false],
  ['prefer', true],
  ['require', true],
  ['verify-ca', true],
  ['verify-full', true],
  ['no-verify', { rejectUnauthorized: false }],
]);

// Errors name the variable and the expected shape but never echo its value
// (see DEPLOYMENT.md, "Secrets and logging").
function persistenceError(field, problem, expected, example) {
  return new Error(`${field} ${problem}. ${expected}. Example: ${example}`);
}

export function persistenceSettings(env) {
  const kind = env.PERSISTENCE || 'memory';
  if (kind === 'memory') return Object.freeze({ kind });
  if (kind !== 'postgres') {
    throw persistenceError('PERSISTENCE', 'is invalid', 'Expected memory or postgres', 'PERSISTENCE=postgres');
  }
  for (const name of ['PGHOST', 'PGDATABASE', 'PGUSER']) {
    if (!env[name]) throw persistenceError(name, 'is missing', 'Expected it whenever PERSISTENCE=postgres', `${name}=...`);
  }
  let port;
  if (env.PGPORT !== undefined && env.PGPORT !== '') {
    port = Number(env.PGPORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw persistenceError('PGPORT', 'is invalid', 'Expected an integer from 1 through 65535', 'PGPORT=5432');
    }
  }
  let ssl;
  if (env.PGSSLMODE) {
    if (!SSL_MODES.has(env.PGSSLMODE)) {
      throw persistenceError('PGSSLMODE', 'is invalid', `Expected one of ${[...SSL_MODES.keys()].join(', ')}`, 'PGSSLMODE=require');
    }
    ssl = SSL_MODES.get(env.PGSSLMODE);
  }
  let statementTimeout = DEFAULT_STATEMENT_TIMEOUT_MS;
  if (env.PG_STATEMENT_TIMEOUT_MS !== undefined && env.PG_STATEMENT_TIMEOUT_MS !== '') {
    statementTimeout = Number(env.PG_STATEMENT_TIMEOUT_MS);
    if (!Number.isInteger(statementTimeout) || statementTimeout < 1) {
      throw persistenceError('PG_STATEMENT_TIMEOUT_MS', 'is invalid', 'Expected a positive integer of milliseconds', 'PG_STATEMENT_TIMEOUT_MS=30000');
    }
  }
  // Explicit values from the injected env, so runCli({ env }) is honored
  // rather than pg falling back to process.env for these fields.
  return Object.freeze({
    kind,
    pool: Object.freeze({
      host: env.PGHOST, port, database: env.PGDATABASE, user: env.PGUSER,
      password: env.PGPASSWORD || undefined, ssl, statement_timeout: statementTimeout,
    }),
  });
}
