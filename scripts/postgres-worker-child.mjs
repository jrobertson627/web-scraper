import { PostgresPersistence } from '../src/persistence/postgres.mjs';
import { createRawStore } from '../src/persistence/index.mjs';
import { createFixtureApplication } from '../src/application/composition-root.mjs';
import { foundationCorpus } from '../fixtures/foundation-corpus.mjs';

const mode = process.argv[2];
if (!['crash', 'resume'].includes(mode) || !process.env.PG_TEST_RAW_ROOT) process.exit(2);

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
const app = createFixtureApplication({ fixtureEntries: foundationCorpus(), sharedState: { persistence, rawStore } });
try {
  const result = await app.runWorkerOnce(mode === 'crash' ? 'interrupted-worker' : 'replacement-worker');
  process.send?.({ done: true, processed: result.processed, parsed: result.jobs.filter((job) => job.state === 'parsed').length });
} catch (error) {
  process.send?.({ error: error.message });
  process.exitCode = 1;
} finally {
  await persistence.close();
}
