import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authorizationStatus, publicationStatus } from '../src/config/authorization.mjs';
import { contractFingerprint } from '../src/config/data-contract.mjs';
import { validateConfiguration } from '../src/config/configuration.mjs';
import { EXIT_CODES } from '../src/application/cli.mjs';

const readRecord = (name) => JSON.parse(readFileSync(new URL(`../config/personal-use.${name}.json`, import.meta.url), 'utf8'));
const authorization = readRecord('authorization');
const dataContract = readRecord('data-contract');
const policy = { minIntervalMs: 6000, maxRequestsPerMinute: 10, hostConcurrency: 1, userAgent: 'personal-web-scraper (+operator@example.com)' };
const rawStoreRoot = join(tmpdir(), 'web-scraper-m1-test-raw');
const workerConfig = {
  mode: 'worker', providerId: authorization.providerId, allowedHosts: authorization.scope.allowedHosts,
  rawStore: 'filesystem', rawStoreRoot, publication: 'private', policy,
  eligibilityPredicate: authorization.scope.eligibilityPredicate,
  targetEndingYears: authorization.scope.targetEndingYears,
  authorization, dataContract,
};

test('personal-use records match their private contract and worker scope', () => {
  assert.equal(authorization.basis, 'personal_use_attestation');
  assert.deepEqual(authorization.uses, ['crawl']);
  assert.equal(dataContract.redistribution, 'private');
  assert.equal(authorization.contractFingerprint, contractFingerprint(dataContract));
  assert.doesNotThrow(() => validateConfiguration(workerConfig));
});

test('personal-use attestation cannot open public publication or a public contract', () => {
  assert.match(publicationStatus(authorization, dataContract, authorization.providerId).reason, /personal-use attestation/);
  assert.match(authorizationStatus({ ...authorization, uses: ['crawl', 'publish'] }, authorization.providerId, 'crawl').reason, /crawl only/);
  const publicContract = { ...dataContract, redistribution: 'public' };
  const matchingAuthorization = { ...authorization, contractFingerprint: contractFingerprint(publicContract) };
  assert.throws(() => validateConfiguration({ ...workerConfig, authorization: matchingAuthorization, dataContract: publicContract }), /dataContract.redistribution/);
});

test('personal worker rejects provider, scope, date, version, and fingerprint mismatches by field', () => {
  const clock = () => new Date('2026-09-23T00:00:00.000Z');
  const cases = [
    [{ ...authorization, providerId: 'other-provider' }, /authorization provider mismatch/],
    [{ ...authorization, scope: { ...authorization.scope, targetEndingYears: [2026] } }, /authorization scope/],
    [{ ...authorization, expiresAt: '2026-09-22T00:00:00.000Z' }, /authorization is expired/],
    [{ ...authorization, contractVersion: 'personal-v0' }, /authorization data contract version/],
    [{ ...authorization, contractFingerprint: '0'.repeat(64) }, /authorization data contract fingerprint/],
  ];
  for (const [record, expected] of cases) {
    assert.throws(() => validateConfiguration({ ...workerConfig, authorization: record }, { clock }), expected);
  }
});

test('worker loads personal records and reaches the missing-adapter boundary without leaking evidence', () => {
  const env = {
    ...process.env,
    PROVIDER_ID: authorization.providerId,
    PROVIDER_HOST: authorization.scope.allowedHosts[0],
    USER_AGENT: policy.userAgent,
    RAW_STORE_ROOT: rawStoreRoot,
    AUTHORIZATION_JSON: JSON.stringify(authorization),
    DATA_CONTRACT_JSON: JSON.stringify(dataContract),
  };
  const accepted = spawnSync(process.execPath, ['src/application/cli.mjs', 'worker'], { cwd: process.cwd(), env, encoding: 'utf8' });
  assert.equal(accepted.status, EXIT_CODES.sourceAdapterMissing);
  assert.match(accepted.stderr, /no production source adapter/);
  const rejected = spawnSync(process.execPath, ['src/application/cli.mjs', 'worker'], {
    cwd: process.cwd(), encoding: 'utf8',
    env: { ...env, AUTHORIZATION_JSON: JSON.stringify({ ...authorization, evidenceRef: 'operator-attestation:secret=TOP_SECRET', scope: { ...authorization.scope, targetEndingYears: [2026] } }) },
  });
  assert.equal(rejected.status, EXIT_CODES.configurationRejected);
  assert.match(rejected.stderr, /scope/);
  assert.doesNotMatch(rejected.stderr, /TOP_SECRET/);
});
