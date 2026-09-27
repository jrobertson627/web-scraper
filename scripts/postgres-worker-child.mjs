import { PostgresPersistence } from '../src/persistence/postgres.mjs';
import { createRawStore } from '../src/persistence/index.mjs';
import { createFixtureApplication } from '../src/application/composition-root.mjs';
import { foundationCorpus } from '../fixtures/foundation-corpus.mjs';
import { FixtureTransport } from '../src/fetcher/index.mjs';
import { runWorkerLoop } from '../src/application/worker-loop.mjs';

const mode = process.argv[2];
if (!['crash', 'resume', 'hang', 'sigterm'].includes(mode) || !process.env.PG_TEST_RAW_ROOT) process.exit(2);

// In sigterm mode the second request is slow, and the parent signals the
// long-running worker while it is on the wire. Windows cannot deliver a
// catchable SIGTERM, so there the parent relays it over IPC.
const slowTransport = { calls: [], fixtures: null, async request(request) {
  this.calls.push(request.url);
  if (this.calls.length === 2) {
    process.send?.({ checkpoint: 'in-request', url: request.url });
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  return this.fixtures.request(request);
} };
if (mode === 'sigterm') process.on('message', (message) => { if (message?.signal) process.emit(message.signal); });

// In hang mode the first request never returns, so the parent can kill this
// worker while it owns the host.
const hangingTransport = { calls: [], async request({ url }) {
  this.calls.push(url);
  process.send?.({ checkpoint: 'in-request', url });
  return new Promise(() => {});
} };

class CheckpointPersistence extends PostgresPersistence {
  async recordParse(run, lease) {
    const id = await super.recordParse(run, lease);
    if (mode === 'crash' && run.jobKey.endsWith(':game_log')) {
      process.send?.({ checkpoint: 'before-page-commit', jobKey: run.jobKey, lease });
      await new Promise(() => {});
    }
    return id;
  }
}

const persistence = new CheckpointPersistence({ claimTimeoutMs: 2000 });
const rawStore = createRawStore('filesystem', process.env.PG_TEST_RAW_ROOT);
const transports = { hang: hangingTransport, sigterm: slowTransport };
slowTransport.fixtures = new FixtureTransport(new Map(foundationCorpus().map((entry) => [entry.url, entry])));
const app = createFixtureApplication({ fixtureEntries: foundationCorpus(),
  sharedState: { persistence, rawStore, ...(transports[mode] ? { transport: transports[mode] } : {}) } });
if (mode === 'sigterm') {
  try {
    await app.ready;
    const result = await runWorkerLoop({ orchestrator: app.orchestrator, workerId: 'signalled-worker' });
    process.send?.({ done: true, stopped: result.stopped, counts: result.counts });
  } finally { await persistence.close(); }
  process.exit(0);
}
try {
  const result = await app.runWorkerOnce(mode === 'resume' ? 'replacement-worker' : 'interrupted-worker');
  process.send?.({ done: true, processed: result.processed, parsed: result.jobs.filter((job) => job.state === 'parsed').length });
} catch (error) {
  process.send?.({ error: error.message });
  process.exitCode = 1;
} finally {
  await persistence.close();
}
