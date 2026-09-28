import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizationStatus, publicationStatus } from '../src/config/authorization.mjs';
import { createDataContract, dataContractStatus, contractFingerprint } from '../src/config/data-contract.mjs';
import { validateConfiguration } from '../src/config/configuration.mjs';

const scope = { allowedHosts: ['provider.example'], eligibilityPredicate: 'To == 2026', targetEndingYears: [2022, 2023, 2024, 2025, 2026] };
const contract = { providerId: 'provider', version: 'v1', retainedFields: ['school', 'games'], attribution: 'Provider', sourceLinksRequired: true, redistribution: 'public', retention: 'indefinite', effectiveAt: '2026-01-01T00:00:00.000Z' };
const authorization = { providerId: 'provider', status: 'active', uses: ['crawl', 'publish'], evidenceRef: 'vault://grant-1', contractVersion: 'v1', scope };
const policy = { minIntervalMs: 6000, maxRequestsPerMinute: 10, hostConcurrency: 1, userAgent: 'test (+ops@example.com)' };

test('data contracts are versioned, fingerprinted, and immutable', () => {
  const value = createDataContract(contract);
  assert.equal(value.fingerprint, contractFingerprint(contract));
  assert.equal(Object.isFrozen(value), true);
  assert.throws(() => { value.version = 'v2'; }, TypeError);
  assert.equal(dataContractStatus(value, 'provider', () => new Date('2026-01-02T00:00:00Z')).ok, true);
});

test('authorization fails closed for scope, contract, expiry, and revocation mismatches', () => {
  const clock = () => new Date('2026-01-02T00:00:00Z');
  assert.equal(authorizationStatus(authorization, 'provider', 'crawl', clock, { expectedScope: { ...scope, allowedHosts: ['other.example'] }, expectedContractVersion: 'v1' }).ok, false);
  assert.equal(authorizationStatus({ ...authorization, revokedAt: '2026-01-01T00:00:00Z' }, 'provider', 'crawl', clock, { expectedScope: scope, expectedContractVersion: 'v1' }).reason, 'authorization is revoked');
  assert.equal(dataContractStatus({ ...contract, expiresAt: '2026-01-01T00:00:00Z' }, 'provider', clock).reason, 'data contract is expired');
});

test('worker/public configuration requires matching authorization and public data contract', () => {
  const input = { mode: 'worker', providerId: 'provider', allowedHosts: scope.allowedHosts, rawStore: 'memory', publication: 'private', policy, authorization, dataContract: contract, ...scope };
  input.authorization = { ...authorization, contractFingerprint: contractFingerprint(contract) };
  assert.doesNotThrow(() => validateConfiguration(input, { clock: () => new Date('2026-01-02T00:00:00Z') }));
  assert.throws(() => validateConfiguration({ ...input, authorization: { ...authorization, scope: { ...scope, targetEndingYears: [2024] } } }), /scope/);
  assert.throws(() => validateConfiguration({ ...input, dataContract: { ...contract, redistribution: 'private' }, mode: 'api', publication: 'public', authorization: { ...input.authorization, contractFingerprint: contractFingerprint({ ...contract, redistribution: 'private' }) } }), /redistribution/);
});

test('public publication gate rejects absent, private, or expired contracts without exposing evidence', () => {
  const clock = () => new Date('2026-01-02T00:00:00Z');
  assert.equal(publicationStatus(authorization, undefined, 'provider', clock).reason, 'missing data contract');
  assert.equal(publicationStatus(authorization, { ...contract, redistribution: 'private' }, 'provider', clock, { dataContractStatus }).reason, 'data contract does not permit public redistribution');
  const denied = publicationStatus({ ...authorization, evidenceRef: 'secret=TOP_SECRET', status: 'revoked' }, contract, 'provider', clock, { dataContractStatus });
  assert.equal(denied.ok, false);
  assert.doesNotMatch(denied.reason, /TOP_SECRET/);
});
