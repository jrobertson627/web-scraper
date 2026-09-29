import { isIP } from 'node:net';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFixtureApplication, createReprocessApplication, createReviewApplication } from './composition-root.mjs';
import { JOB_DISPOSITIONS, formatReviewList } from './review.mjs';
import { buildReconciliationReport } from './reconciliation.mjs';
import { assertOperatorPin, createOperatorServer } from './operator-server.mjs';
import { buildManifestReport, formatManifestReport } from './manifest.mjs';
import { CRAWL_STAGES } from '../contracts/crawl-scope.mjs';
import { operatorAllowlist, operatorAuthorizer } from '../config/operators.mjs';
import { ApplicationLifecycle } from './lifecycle.mjs';
import { runWorkerLoop } from './worker-loop.mjs';
import { WorkerStartRefused, startProductionWorker } from './production-worker.mjs';
import { validateConfiguration } from '../config/configuration.mjs';
import { persistenceSettings } from '../config/persistence.mjs';
import { PAGE_TYPES } from '../contracts/source.mjs';
import { REPROCESS_STATES } from '../contracts/jobs.mjs';
import { openPostgresPersistence } from '../persistence/postgres.mjs';
import { FileRawStore } from '../persistence/index.mjs';
import { createQueryService, createApiServer } from '../api/public.mjs';
import { createCrawlLog } from './crawl-log.mjs';
import { STATUS_WINDOW_MS, formatCrawlStatus, summarizeCrawlStatus } from './crawl-status.mjs';

export const EXIT_CODES = Object.freeze({
  success: 0,
  runtimeFailure: 1,
  invalidMode: 2,
  configurationRejected: 3,
  // Configuration is valid, but the worker cannot crawl yet (a production part is missing).
  workerNotReady: 4,
  sourceAdapterMissing: 4, // earlier name for workerNotReady
  // The reconciliation report ran and found failing checks or quarantined
  // records, or the raw repair inventory found objects pending repair.
  reconciliationFailed: 5,
  // The crawl halted on a challenge response that awaits operator review.
  haltedForReview: 6,
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

// PARSER_VERSIONS overrides the parser version of some page types, as JSON,
// for example {"box_score":"2"}; the rest stay at '1'. Configuration validation
// checks the result.
function parseParserVersions(value) {
  if (!value) return undefined;
  let overrides;
  try { overrides = JSON.parse(value); } catch {
    throw new Error('PARSER_VERSIONS is invalid JSON. Expected an object of page types to versions. Example: PARSER_VERSIONS={"box_score":"2"}');
  }
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new Error('PARSER_VERSIONS is invalid. Expected an object of page types to versions. Example: PARSER_VERSIONS={"box_score":"2"}');
  }
  return { ...Object.fromEntries(PAGE_TYPES.map((pageType) => [pageType, '1'])), ...overrides };
}

// CRAWL_SAMPLE restricts the crawl to a sample (#78), as JSON, for example
// {"schools":["/cbb/schools/duke/men/"],"endingYears":[2024]}. Configuration
// validation checks it against the full scope.
function parseCrawlSample(value) {
  if (!value) return undefined;
  try { return JSON.parse(value); } catch {
    throw new Error('CRAWL_SAMPLE is invalid JSON. Expected {"schools":[...],"endingYears":[...]}. Example: CRAWL_SAMPLE={"schools":["/cbb/schools/duke/men/"],"endingYears":[2024]}');
  }
}

// The worker configuration from the environment; worker and reprocess modes share it.
function workerConfiguration(env) {
  return validateConfiguration({
    mode: 'worker', providerId: env.PROVIDER_ID ?? 'provider', allowedHosts: [env.PROVIDER_HOST ?? 'provider.example'],
    rawStore: 'filesystem', rawStoreRoot: env.RAW_STORE_ROOT, publication: 'private',
    policy: { minIntervalMs: 6000, maxRequestsPerMinute: 10, hostConcurrency: 1, userAgent: env.USER_AGENT ?? '' },
    eligibilityPredicate: env.ELIGIBILITY_PREDICATE ?? 'To == 2026', targetEndingYears: [2022, 2023, 2024, 2025, 2026],
    authorization: parseAuthorization(env.AUTHORIZATION_JSON),
    dataContract: parseDataContract(env.DATA_CONTRACT_JSON),
    parserVersions: parseParserVersions(env.PARSER_VERSIONS),
    crawlScope: parseCrawlSample(env.CRAWL_SAMPLE),
    crawlStage: env.CRAWL_STAGE || 'full',
  });
}

const REPROCESS_USAGE = 'Example: npm run reprocess -- --page-type box_score --state parse_failed (or --job <job key>)';

// --page-type and --state take one value or a comma-separated list and may
// repeat; --job names one job key and may repeat.
export function parseReprocessArgs(args) {
  const selection = {};
  const add = (field, value) => { selection[field] = [...(selection[field] ?? []), ...value.split(',').filter(Boolean)]; };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    const field = { '--page-type': 'pageTypes', '--state': 'states', '--job': 'jobKeys' }[flag];
    if (!field || value === undefined || value.startsWith('--')) throw new Error(`reprocess argument ${flag} is invalid. ${REPROCESS_USAGE}`);
    if (field === 'jobKeys') selection.jobKeys = [...(selection.jobKeys ?? []), value];
    else add(field, value);
    index += 1;
  }
  if (selection.jobKeys && (selection.pageTypes || selection.states)) throw new Error(`reprocess takes --job or a --page-type/--state selection, not both. ${REPROCESS_USAGE}`);
  const unknownType = selection.pageTypes?.find((pageType) => !PAGE_TYPES.includes(pageType));
  if (unknownType !== undefined) throw new Error(`reprocess --page-type ${unknownType} is invalid. Expected some of ${PAGE_TYPES.join(', ')}. ${REPROCESS_USAGE}`);
  const unknownState = selection.states?.find((state) => !REPROCESS_STATES.includes(state));
  if (unknownState !== undefined) throw new Error(`reprocess --state ${unknownState} is invalid. Expected ${REPROCESS_STATES.join(' or ')}. ${REPROCESS_USAGE}`);
  return selection;
}

// The page types a run claims: all of them, or for CRAWL_STAGE=manifest (#44)
// only the school index and history pages.
function stagePageTypes(config) {
  return config.crawlStage === 'manifest' ? CRAWL_STAGES.manifest : undefined;
}

const REVIEW_USAGE = 'Example: npm run review -- list, npm run review -- show <job key | issue id>, '
  + 'npm run review -- release-retry <job key> --operator <id> --reason "<why>"';
const REVIEW_ACTIONS = new Set([...Object.keys(JOB_DISPOSITIONS), 'accept', 'dismiss']);

// review <list|show|hold|release-retry|release-permanent|accept|dismiss> ...
export function parseReviewArgs(args) {
  const [command, ...rest] = args;
  const review = { command };
  if (command === 'list') {
    for (let index = 0; index < rest.length; index += 1) {
      const flag = rest[index];
      if (flag === '--json') review.json = true;
      else if (flag === '--jobs') review.issues = false;
      else if (flag === '--issues') review.jobs = false;
      else if (flag === '--state' && rest[index + 1]) { review.states = [...(review.states ?? []), ...rest[index + 1].split(',')]; index += 1; }
      else if (flag === '--limit' && /^\d+$/.test(rest[index + 1] ?? '')) { review.limit = Number(rest[index + 1]); index += 1; }
      else throw new Error(`review list argument ${flag} is invalid. Expected --jobs, --issues, --state <state>, --limit <n> or --json`);
    }
    return review;
  }
  if (command !== 'show' && !REVIEW_ACTIONS.has(command)) throw new Error(`review command ${command ?? '(none)'} is invalid. ${REVIEW_USAGE}`);
  review.target = rest[0];
  if (!review.target || review.target.startsWith('--')) throw new Error(`review ${command} needs a job key or issue id. ${REVIEW_USAGE}`);
  for (let index = 1; index < rest.length; index += 2) {
    const field = { '--operator': 'operatorId', '--reason': 'reason' }[rest[index]];
    if (command === 'show' || !field || rest[index + 1] === undefined) throw new Error(`review ${command} argument ${rest[index]} is invalid. ${REVIEW_USAGE}`);
    review[field] = rest[index + 1];
  }
  if (command !== 'show' && (!review.operatorId || !review.reason?.trim())) {
    throw new Error(`review ${command} needs --operator <id> and --reason "<why>"; every disposition is recorded. ${REVIEW_USAGE}`);
  }
  return review;
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

// How many proxies stand in front of the operator trigger. The client address is
// the X-Forwarded-For entry that many from the end, which Render's proxy appends,
// so the wrong-PIN lockout is per client (#125). Use 0 when nothing proxies it.
function configuredProxyHops(env) {
  const value = env.OPERATOR_TRUSTED_PROXY_HOPS;
  if (value === undefined || value === '') return 1;
  if (!/^\d$/.test(value)) throw new Error('invalid OPERATOR_TRUSTED_PROXY_HOPS. Expected a whole number from 0 through 9. Example: OPERATOR_TRUSTED_PROXY_HOPS=1');
  return Number(value);
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
async function serveApi({ lifecycle, server, port, host, stdout, onClose = async () => {}, label = 'API' }) {
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
  stdout(`${label} ready on ${displayUrl(host, port)}`);
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
  // Assembles the worker and returns { orchestrator, workerId?, close? }; see
  // startProductionWorker. Tests inject fakes here.
  startWorker = startProductionWorker,
  // Assembles offline reprocessing; see createReprocessApplication.
  createReprocess = createReprocessApplication,
  // Assembles operator review; see createReviewApplication.
  createReviewer = createReviewApplication,
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

  if (mode === 'reprocess') {
    // Offline reprocessing of stored raw snapshots (#43): no transport is built.
    let config;
    let settings;
    let selection;
    try {
      settings = persistenceSettings(env);
      config = workerConfiguration(env);
      selection = parseReprocessArgs(args);
      if (settings.kind !== 'postgres') throw new Error('reprocess needs the durable store, but PERSISTENCE is memory. Example: PERSISTENCE=postgres');
    } catch (error) {
      stderr(`reprocess configuration rejected: ${safeMessage(error)}`);
      return { exitCode: EXIT_CODES.configurationRejected };
    }
    let persistence;
    try {
      persistence = await openPostgres(settings);
    } catch (error) {
      stderr(`reprocess persistence unavailable: ${safeMessage(error)}`);
      return { exitCode: EXIT_CODES.runtimeFailure };
    }
    try {
      const app = createReprocess({ config, persistence, events: crawlLog });
      const summary = await app.reprocess(selection);
      stdout(JSON.stringify({ mode, ...summary }, null, 2));
      return { exitCode: EXIT_CODES.success, summary };
    } catch (error) {
      stderr(`reprocess failed: ${safeMessage(error)}`);
      return { exitCode: EXIT_CODES[error?.exit] ?? EXIT_CODES.runtimeFailure };
    } finally { await persistence.close(); }
  }

  if (mode === 'operator') {
    // The PIN-protected operator trigger (#55): an HTTP server whose trigger
    // runs the same production worker as worker mode, in this process. It is
    // separate from the read-only API and needs the worker configuration.
    let settings;
    let config;
    let port;
    let host;
    let pin;
    let trustedProxyHops;
    try {
      settings = persistenceSettings(env);
      config = workerConfiguration(env);
      port = configuredPort(env);
      host = configuredHost(env);
      pin = assertOperatorPin(env.OPERATOR_PIN);
      trustedProxyHops = configuredProxyHops(env);
      if (settings.kind !== 'postgres') throw new Error('the operator trigger runs real crawls, which need PERSISTENCE=postgres. Example: PERSISTENCE=postgres');
    } catch (error) {
      stderr(`operator configuration rejected: ${safeMessage(error)}`);
      return { exitCode: EXIT_CODES.configurationRejected };
    }
    const lifecycle = new ApplicationLifecycle('operator');
    // This handle serves status and the live-claim check; each run opens its own.
    const persistence = await openPostgres(settings);
    const operator = createOperatorServer({
      pin,
      trustedProxyHops,
      liveClaims: () => persistence.liveClaimCount(),
      unreviewedChallenges: () => persistence.unreviewedChallenges(),
      status: async () => summarizeCrawlStatus(await persistence.crawlStatus({ windowMs: STATUS_WINDOW_MS })),
      startRun: async (signal) => {
        const worker = await startWorker({ config, settings, env, events: crawlLog, openPostgres });
        try {
          const result = await worker.orchestrator.run({ workerId: worker.workerId ?? env.WORKER_ID ?? 'operator', signal, pageTypes: stagePageTypes(config) });
          crawlLog.summary?.({ jobStates: result.counts, stopped: result.stopped });
          return result;
        } finally { await worker.close?.(); }
      },
      onRunSettled: (last) => stderr(JSON.stringify({ at: new Date().toISOString(), event: 'operator.run_settled', outcome: last?.outcome,
        processed: last?.result?.processed, stopped: last?.result?.stopped, stopReason: last?.result?.stopReason ?? undefined,
        error: last?.error ? safeMessage(last.error) : undefined })),
    });
    try {
      lifecycle.ready();
      const close = await serveApi({ lifecycle, server: operator.server, port, host, stdout, label: 'operator trigger',
        onClose: async () => { await operator.shutdown(); await persistence.close(); } });
      return { exitCode: EXIT_CODES.success, lifecycle, operator, server: operator.server, close };
    } catch (error) {
      lifecycle.stop();
      await persistence.close().catch(() => {});
      throw error;
    }
  }

  if (mode === 'repair') {
    // The raw-store repair inventory (RAW_STORAGE.md): compares every recorded
    // fetch with the objects under RAW_STORE_ROOT. Read-only for the raw store;
    // PostgreSQL records the pending and orphan findings. No transport.
    let settings;
    try {
      settings = persistenceSettings(env);
      if (settings.kind !== 'postgres') throw new Error('repair reads the durable store, but PERSISTENCE is memory. Example: PERSISTENCE=postgres');
      if (typeof env.RAW_STORE_ROOT !== 'string' || !isAbsolute(env.RAW_STORE_ROOT)) throw new Error('RAW_STORE_ROOT is invalid. Expected an absolute path. Example: RAW_STORE_ROOT=/var/data/raw');
    } catch (error) {
      stderr(`repair configuration rejected: ${safeMessage(error)}`);
      return { exitCode: EXIT_CODES.configurationRejected };
    }
    const persistence = await openPostgres(settings);
    try {
      const report = await persistence.repairRawObjects({ rawStore: new FileRawStore(env.RAW_STORE_ROOT) });
      stdout(JSON.stringify({ mode, ...report }, null, 2));
      return { exitCode: report.counts.pending ? EXIT_CODES.reconciliationFailed : EXIT_CODES.success, report };
    } finally { await persistence.close(); }
  }

  if (mode === 'manifest') {
    // The manifest dry-run report (#44) over the durable store: read-only, no
    // transport. Run a worker with CRAWL_STAGE=manifest first.
    let settings;
    try {
      settings = persistenceSettings(env);
      if (settings.kind !== 'postgres') throw new Error('manifest reads the durable store, but PERSISTENCE is memory. Example: PERSISTENCE=postgres');
      if (args.some((arg) => arg !== '--json')) throw new Error('manifest takes only --json. Example: npm run manifest');
    } catch (error) {
      stderr(`manifest configuration rejected: ${safeMessage(error)}`);
      return { exitCode: EXIT_CODES.configurationRejected };
    }
    const persistence = await openPostgres(settings);
    try {
      const report = await buildManifestReport(persistence);
      stdout(args.includes('--json') ? JSON.stringify({ mode, ...report }, null, 2) : formatManifestReport(report));
      return { exitCode: EXIT_CODES.success, report };
    } finally { await persistence.close(); }
  }

  if (mode === 'reconcile') {
    // The reconciliation report over the durable store (#46, #78): read-only,
    // no transport. Exit 0 when every check passes and nothing is quarantined,
    // 5 when the report names failures.
    let settings;
    try {
      settings = persistenceSettings(env);
      if (settings.kind !== 'postgres') throw new Error('reconcile reads the durable store, but PERSISTENCE is memory. Example: PERSISTENCE=postgres');
      if (args.some((arg) => arg !== '--require-coverage')) throw new Error('reconcile takes only --require-coverage. Example: npm run reconcile');
    } catch (error) {
      stderr(`reconcile configuration rejected: ${safeMessage(error)}`);
      return { exitCode: EXIT_CODES.configurationRejected };
    }
    let persistence;
    try {
      persistence = await openPostgres(settings);
    } catch (error) {
      stderr(`reconcile persistence unavailable: ${safeMessage(error)}`);
      return { exitCode: EXIT_CODES.runtimeFailure };
    }
    try {
      const report = await buildReconciliationReport(persistence, { requireCoverage: args.includes('--require-coverage') });
      crawlLog.emit('reconciliation.completed', { passed: report.passed,
        failedChecks: report.checks.filter((check) => !check.passed).length, quarantined: report.quarantined.length });
      stdout(JSON.stringify({ mode, ...report }, null, 2));
      return { exitCode: report.passed ? EXIT_CODES.success : EXIT_CODES.reconciliationFailed, report };
    } finally { await persistence.close(); }
  }

  if (mode === 'review') {
    // Operator review (#48): database-backed, read-mostly; actions are recorded
    // dispositions by an OPERATOR_IDS reviewer. No transport is built.
    let settings;
    let review;
    let config;
    try {
      settings = persistenceSettings(env);
      review = parseReviewArgs(args);
      if (settings.kind !== 'postgres') throw new Error('review reads the durable store, but PERSISTENCE is memory. Example: PERSISTENCE=postgres');
      if (REVIEW_ACTIONS.has(review.command) && !operatorAllowlist(env.OPERATOR_IDS).includes(review.operatorId)) {
        throw new Error(`OPERATOR_IDS does not list operator ${review.operatorId}. Only a listed reviewer may record a disposition. Example: OPERATOR_IDS=${review.operatorId}`);
      }
      // Only accept re-derives a page, which needs the worker configuration.
      if (review.command === 'accept') config = workerConfiguration(env);
    } catch (error) {
      stderr(`review configuration rejected: ${safeMessage(error)}`);
      return { exitCode: EXIT_CODES.configurationRejected };
    }
    let persistence;
    try {
      persistence = await openPostgres({ ...settings, authorizeOperator: operatorAuthorizer(env.OPERATOR_IDS) });
    } catch (error) {
      stderr(`review persistence unavailable: ${safeMessage(error)}`);
      return { exitCode: EXIT_CODES.runtimeFailure };
    }
    try {
      const app = createReviewer({ persistence, config });
      const by = { operatorId: review.operatorId, reason: review.reason };
      let result;
      if (review.command === 'list') {
        result = await app.list({ jobs: review.jobs ?? true, issues: review.issues ?? true, states: review.states, limit: review.limit });
        stdout(review.json ? JSON.stringify(result, null, 2) : formatReviewList(result));
      } else {
        if (review.command === 'show') result = await app.show(review.target);
        else if (review.command === 'accept') result = await app.accept(review.target, by);
        else if (review.command === 'dismiss') result = await app.dismiss(review.target, by);
        else result = await app.dispose(review.target, review.command, by);
        stdout(JSON.stringify(result, null, 2));
      }
      return { exitCode: EXIT_CODES.success, result };
    } catch (error) {
      stderr(`review ${review.command} failed: ${safeMessage(error)}`);
      return { exitCode: EXIT_CODES.runtimeFailure };
    } finally { await persistence.close(); }
  }

  if (mode === 'worker') {
    let config;
    let settings;
    try {
      settings = persistenceSettings(env);
      config = workerConfiguration(env);
    } catch (error) {
      stderr(`worker configuration rejected: ${safeMessage(error)}`);
      return { exitCode: EXIT_CODES.configurationRejected };
    }
    let worker;
    try {
      worker = await startWorker({ config, settings, env, events: crawlLog, openPostgres });
    } catch (error) {
      if (error instanceof WorkerStartRefused) {
        stderr(safeMessage(error));
        return { exitCode: EXIT_CODES[error.exit] ?? EXIT_CODES.runtimeFailure };
      }
      stderr(`worker startup failed: ${safeMessage(error)}`);
      return { exitCode: EXIT_CODES.runtimeFailure };
    }
    // The loop runs until the work is done or SIGTERM/SIGINT stops it, then
    // releases what startWorker opened.
    try {
      const result = await runWorkerLoop({ orchestrator: worker.orchestrator, workerId: worker.workerId ?? env.WORKER_ID ?? 'worker', log: stderr,
        pageTypes: stagePageTypes(config) });
      crawlLog.summary?.({ jobStates: result.counts, stopped: result.stopped });
      stdout(JSON.stringify({ mode, ...result }));
      if (result.halt) {
        stderr(`worker halted: a challenge response on ${result.halt.jobKey} awaits operator review; no request is made until every challenge stop is reviewed. `
          + 'Pause the service, then: npm run review -- list --state operator_stop (see OPERATIONS_RUNBOOK.md)');
        return { exitCode: EXIT_CODES.haltedForReview, result };
      }
      return { exitCode: EXIT_CODES.success, result };
    } finally { await worker.close?.(); }
  }

  stderr(`invalid runtime mode: ${mode}. Expected local, worker, operator, reprocess, review, reconcile, repair, manifest, api, or status. Example: npm run start:local`);
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
