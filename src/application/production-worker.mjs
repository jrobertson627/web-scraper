import { createWorkerApplication } from './composition-root.mjs';
import { NO_CRAWL_EVENTS } from './crawl-log.mjs';
import { HttpTransport } from '../fetcher/http-transport.mjs';
import { openPostgresPersistence } from '../persistence/postgres.mjs';
import { createProductionParserRegistry, missingProductionParsers } from '../parsers/index.mjs';

// A refusal the CLI reports with a specific exit code: `exit` names an
// EXIT_CODES entry and the message is safe to print as it is.
export class WorkerStartRefused extends Error {
  constructor(exit, message) {
    super(message);
    this.name = 'WorkerStartRefused';
    this.exit = exit;
  }
}

// The production startWorker for `cli.mjs worker` (#97). runCli has already
// validated the configuration, so the authorization and data-contract gate ran
// first. This opens PostgreSQL with the lease and request deadlines from that
// configuration, refuses to start while a production parser is missing, builds
// the app with createWorkerApplication, and seeds the school-index root job.
// The persistence it opened is closed by the returned close(), or here if
// startup fails.
export async function startProductionWorker({
  config, settings, env = {}, events = NO_CRAWL_EVENTS,
  openPostgres = openPostgresPersistence,
  parsers = createProductionParserRegistry(),
  transport = new HttpTransport(),
  createApp = createWorkerApplication,
} = {}) {
  let persistence;
  if (settings.kind === 'postgres') {
    try {
      persistence = await openPostgres({ ...settings, claimTimeoutMs: config.claimTimeoutMs, requestTimeoutMs: config.policy.requestTimeoutMs });
    } catch (error) {
      throw new WorkerStartRefused('runtimeFailure', `worker persistence unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const close = async () => { await persistence?.close(); };
  try {
    const missing = missingProductionParsers(parsers, config.parserVersions);
    if (missing.length) {
      throw new WorkerStartRefused('workerNotReady', `worker configuration accepted for ${config.providerId} (${settings.kind} persistence), but no production parser is registered for ${missing.join(', ')}; no crawl started`);
    }
    if (!persistence) {
      throw new WorkerStartRefused('configurationRejected', `worker configuration rejected: a real crawl needs durable persistence, but PERSISTENCE is ${settings.kind}. Example: PERSISTENCE=postgres`);
    }
    // config is already validated; createWorkerApplication validates it again
    // against the real clock, which is idempotent for a validated config.
    const app = await createApp({ config, transport, persistence, parsers, events });
    await app.seedRootJob();
    return { app, orchestrator: app.orchestrator, workerId: env.WORKER_ID, close };
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}
