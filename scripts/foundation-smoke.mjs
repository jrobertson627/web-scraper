import { createFixtureApplication } from '../src/application/composition-root.mjs';
import { foundationCorpus } from '../fixtures/foundation-corpus.mjs';

const faults = process.argv.includes('--faults');
const app = createFixtureApplication({ fixtureEntries: foundationCorpus({ faults }) });
const preview = app.previewDryRun();
const result = await app.runWorkerOnce('foundation-smoke-worker');
const reconciliation = app.reconcile();
console.log(JSON.stringify({
  mode: 'fixture-smoke', readiness: 'ready', faults, preview,
  jobs: result.jobs.length,
  jobStates: app.persistence.queryModels().health.jobStates,
  transportCalls: result.transportCalls,
  reconciliation,
}, null, 2));
if (!reconciliation.passed || result.jobs.some((job) => job.state !== 'parsed')) process.exitCode = 1;
