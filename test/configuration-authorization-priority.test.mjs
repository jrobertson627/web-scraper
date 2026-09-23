import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfiguration } from '../src/config/configuration.mjs';

function baseConfig(overrides = {}) {
  return {
    mode: 'worker', providerId: 'provider', allowedHosts: ['provider.example'], rawStore: 'filesystem', rawStoreRoot: '/var/lib/raw',
    policy: { minIntervalMs: 6000, maxRequestsPerMinute: 10, hostConcurrency: 1, userAgent: 'scraper (+ops@example.com)' },
    eligibilityPredicate: 'To == 2026', targetEndingYears: [2022, 2023, 2024, 2025, 2026],
    publication: 'private',
    ...overrides,
  };
}

test('a missing authorization is reported even when the data contract is also invalid', () => {
  assert.throws(
    () => validateConfiguration(baseConfig({ dataContract: { providerId: 'provider' } })),
    /missing authorization evidence/,
  );
});

test('an invalid data contract is still reported once authorization is present', () => {
  assert.throws(
    () => validateConfiguration(baseConfig({
      authorization: { providerId: 'provider', status: 'active', uses: ['crawl'], evidenceRef: 'ref' },
      dataContract: { providerId: 'provider' },
    })),
    /data contract version is missing/,
  );
});
