import { readFileSync } from 'node:fs';
import { runCli } from '../src/application/cli.mjs';

const readRecord = (name) => JSON.parse(readFileSync(new URL(`../config/personal-use.${name}.json`, import.meta.url), 'utf8'));
const authorization = readRecord('authorization');
const dataContract = readRecord('data-contract');

const { exitCode } = await runCli({
  mode: 'worker',
  env: {
    ...process.env,
    PROVIDER_ID: authorization.providerId,
    PROVIDER_HOST: authorization.scope.allowedHosts[0],
    AUTHORIZATION_JSON: JSON.stringify(authorization),
    DATA_CONTRACT_JSON: JSON.stringify(dataContract),
  },
});
process.exitCode = exitCode;
