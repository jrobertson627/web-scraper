import { readFileSync } from 'node:fs';
import { runCli } from '../src/application/cli.mjs';
import { exitOrIdle } from '../src/application/idle.mjs';

const readRecord = (name) => JSON.parse(readFileSync(new URL(`../config/personal-use.${name}.json`, import.meta.url), 'utf8'));
const authorization = readRecord('authorization');
const dataContract = readRecord('data-contract');

// `node scripts/personal-worker.mjs [worker|reprocess] [args...]`: the same
// records for the crawl and for offline reprocessing of its stored snapshots.
const mode = process.argv[2] ?? 'worker';
const { exitCode } = await runCli({
  mode,
  args: process.argv.slice(3),
  env: {
    ...process.env,
    PROVIDER_ID: authorization.providerId,
    PROVIDER_HOST: authorization.scope.allowedHosts[0],
    AUTHORIZATION_JSON: JSON.stringify(authorization),
    DATA_CONTRACT_JSON: JSON.stringify(dataContract),
  },
});
// A Render worker that exits is restarted; WORKER_IDLE_ON_EXIT keeps it up (#126).
try {
  process.exitCode = await exitOrIdle({ mode, exitCode });
} catch (error) {
  console.error(`worker idle rejected: ${error.message}`);
  process.exitCode = 3;
}
