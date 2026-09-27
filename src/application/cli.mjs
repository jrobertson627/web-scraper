import { isIP } from 'node:net';
import { pathToFileURL } from 'node:url';
import { createFixtureApplication } from './composition-root.mjs';
import { ApplicationLifecycle } from './lifecycle.mjs';
import { validateConfiguration } from '../config/configuration.mjs';
import { persistenceSettings } from '../config/persistence.mjs';
import { openPostgresPersistence } from '../persistence/postgres.mjs';
import { createQueryService, createApiServer } from '../api/public.mjs';
import { createCrawlLog } from './crawl-log.mjs';
import { STATUS_WINDOW_MS, formatCrawlStatus, summarizeCrawlStatus } from './crawl-status.mjs';

export const EXIT_CODES = Object.freeze({
  success: 0,
  runtimeFailure: 1,
  invalidMode: 2,
  configurationRejected: 3,
  sourceAdapterMissing: 4,
});

// Best-effort scrub for stderr/console output. Matches "key=value" (env-style)
// and "key": "value" / key: value (JSON-style) for a superset of secret-shaped
// field names, so a future error path that interpolates raw config still gets
// redacted instead of relying on every caller never doing that.
const SENSITIVE_KEY_VALUE = /"?\b(password|secret|token|credential|api[_-]?key|bearer)\b"?\s*[:=]\s*("(?:[^"\\]|\\.)*"|\S+)/gi;

export function safeMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(SENSITIVE_KEY_VALUE, (_match, key) => `${key}=[redacted]`);
}

function parseAuthorization(value) {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error('authorization configuration is invalid JSON. Expected an authorization object; secret-bearing input was redacted.');
  }
}

function parseDataContract(value) {
  if (!value) return undefined;
  try { return JSON.parse(value); } catch {
    throw new Error('data contract configuration is invalid JSON. Expected a data contract object; secret-bearing input was redacted.');
  }
}

function configuredPort(env) {
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('invalid PORT. Expected an integer from 1 through 65535. Example: PORT=3000');
  }
  return port;
}

// Loopback by default. The API has no authentication of its own, so binding
// another address (HOST=0.0.0.0) is only for use behind an authenticating
// layer; see DEPLOYMENT.md.
function configuredHost(env) {
  const host = env.HOST || '127.0.0.1';
  if (host !== 'localhost' && !isIP(host)) {
    throw new Error('invalid HOST. Expected an IP address or localhost. Example: HOST=0.0.0.0');
  }
  return host;
}

function displayUrl(host, port) {
  return `http://${isIP(host) === 6 ? `[${host}]` : host}:${port}`;
}

async function listen(server, port, host) {
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolve();
    });
  });
}

// Listens, wires SIGINT/SIGTERM to an idempotent close, and marks the
// lifecycle running. onClose releases anything the server was reading from.
async function serveApi({ lifecycle, server, port, host, stdout, onClose = async () => {} }) {
  let closing;
  const close = () => {
    if (closing) return closing;
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    closing = new Promise((resolve, reject) => server.close((error) => {
      lifecycle.stop();
      if (error) reject(error);
      else resolve();
    })).finally(onClose);
    return closing;
  };
  const onSignal = () => { void close(); };
  await listen(server, port, host);
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  lifecycle.running();
  stdout(`API ready on ${displayUrl(host, port)}`);
  return close;
}

export async function runCli({
  mode = process.argv[2] ?? 'local',
  env = process.env,
  stdout = (message) => console.log(message),
  stderr = (message) => console.error(message),
  openPostgres = openPostgresPersistence,
  args = process.argv.slice(3),
  crawlLog = createCrawlLog({ write: stderr }),
} = {}) {
  if (mode === 'local') {
    const app = createFixtureApplication({ events: crawlLog });
    app.lifecycle.ready();
    stdout('fixture local ready');
    app.lifecycle.running();
    let result;
    try {
      result = await app.runWorkerOnce();
    } finally {
      app.lifecycle.stop();
    }
    stdout(JSON.stringify({ mode, lifecycle: app.lifecycle.state, ...result }, null, 2));
    return { exitCode: EXIT_CODES.success, app };
  }

  if (mode === 'status') {
    // Operator progress report; read-only against the configured store.
    let settings;
    try {
      settings = persistenceSettings(env);
    } catch (error) {
      stderr(`status configuration rejected: ${safeMessage(error)}`);
      return { exitCode: EXIT_CODES.configurationRejected };
    }
    let status;
    if (settings.kind === 'postgres') {
      const persistence = await openPostgres(settings);
      try { status = await persistence.crawlStatus({ windowMs: STATUS_WINDOW_MS }); } finally { await persistence.close(); }
    } else {
      // Memory has no durable crawl to report, so show the fixture crawl's.
      const app = createFixtureApplication();
      await app.runWorkerOnce();
      status = await app.persistence.crawlStatus({ windowMs: STATUS_WINDOW_MS });
    }
    const summary = summarizeCrawlStatus(status);
    stdout(args.includes('--json') ? JSON.stringify(summary, null, 2) : formatCrawlStatus(summary));
    return { exitCode: EXIT_CODES.success, summary };
  }

  if (mode === 'api') {
    let settings;
    let port;
    let host;
    try {
      settings = persistenceSettings(env);
      port = configuredPort(env);
      host = configuredHost(env);
    } catch (error) {
      stderr(`api configuration rejected: ${safeMessage(error)}`);
      return { exitCode: EXIT_CODES.configurationRejected };
    }

    if (settings.kind === 'postgres') {
      // Read-only against the durable store: no fixture crawl is written into it.
      const lifecycle = new ApplicationLifecycle('api');
      const persistence = await openPostgres(settings);
      try {
        lifecycle.ready();
        const server = createApiServer({ queries: createQueryService(persistence), config: { mode: 'api', publication: 'private' } });
        const close = await serveApi({ lifecycle, server, port, host, stdout, onClose: () => persistence.close() });
        return { exitCode: EXIT_CODES.success, lifecycle, persistence, server, close };
      } catch (error) {
        lifecycle.stop();
        await persistence.close().catch(() => {});
        throw error;
      }
    }

    const app = createFixtureApplication();
    app.lifecycle.ready();
    try {
      await app.runWorkerOnce();
      const server = app.createApiServer();
      const close = await serveApi({ lifecycle: app.lifecycle, server, port, host, stdout });
      return { exitCode: EXIT_CODES.success, app, server, close };
    } catch (error) {
      app.lifecycle.stop();
      throw error;
    }
  }

  if (mode === 'worker') {
    let config;
    let settings;
    try {
      settings = persistenceSettings(env);
      config = validateConfiguration({
        mode: 'worker', providerId: env.PROVIDER_ID ?? 'provider', allowedHosts: [env.PROVIDER_HOST ?? 'provider.example'],
        rawStore: 'filesystem', rawStoreRoot: env.RAW_STORE_ROOT, publication: 'private',
        policy: { minIntervalMs: 6000, maxRequestsPerMinute: 10, hostConcurrency: 1, userAgent: env.USER_AGENT ?? '' },
        eligibilityPredicate: env.ELIGIBILITY_PREDICATE ?? 'To == 2026', targetEndingYears: [2022, 2023, 2024, 2025, 2026],
        authorization: parseAuthorization(env.AUTHORIZATION_JSON),
        dataContract: parseDataContract(env.DATA_CONTRACT_JSON),
      });
    } catch (error) {
      stderr(`worker configuration rejected: ${safeMessage(error)}`);
      return { exitCode: EXIT_CODES.configurationRejected };
    }
    if (settings.kind === 'postgres') {
      // Verify the durable store up front so a deploy surfaces an unreachable
      // or unmigrated database now rather than once a source adapter exists.
      try {
        const persistence = await openPostgres({ ...settings, claimTimeoutMs: config.claimTimeoutMs });
        await persistence.close();
      } catch (error) {
        stderr(`worker persistence unavailable: ${safeMessage(error)}`);
        return { exitCode: EXIT_CODES.runtimeFailure };
      }
    }
    stderr(`worker configuration accepted for ${config.providerId} (${settings.kind} persistence), but no production source adapter is configured; no crawl started`);
    return { exitCode: EXIT_CODES.sourceAdapterMissing };
  }

  stderr(`invalid runtime mode: ${mode}. Expected local, worker, api, or status. Example: npm run start:local`);
  return { exitCode: EXIT_CODES.invalidMode };
}

async function main() {
  try {
    const result = await runCli();
    process.exitCode = result.exitCode;
  } catch (error) {
    console.error(`runtime startup failed: ${safeMessage(error)}`);
    process.exitCode = EXIT_CODES.runtimeFailure;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
