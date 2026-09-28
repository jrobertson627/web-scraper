import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalizeSourceUrl, createSourceUrl, isAllowedSourceUrl } from '../src/contracts/source.mjs';
import { Discovery } from '../src/discovery/index.mjs';

const scope = { providerId: 'provider', allowedHosts: ['allowed.example'], targetEndingYears: [2022, 2023, 2024, 2025, 2026] };

test('source URL identity rejects credentials/fragments and derives allowlisting from the URL itself', () => {
  assert.throws(() => createSourceUrl('provider', 'https://user:pass@allowed.example/page'), /credentials/);
  assert.throws(() => createSourceUrl('provider', 'https://allowed.example/page#fragment'), /fragment/);
  assert.equal(isAllowedSourceUrl({ providerId: 'provider', absoluteUrl: 'https://blocked.example/page', host: 'allowed.example' }, scope.allowedHosts), false);
  assert.equal(isAllowedSourceUrl({ providerId: 'provider', absoluteUrl: 'https://allowed.example/page', host: 'blocked.example' }, scope.allowedHosts), true);
  assert.equal(isAllowedSourceUrl({ providerId: 'provider', absoluteUrl: 'https://allowed.example:8443/page' }, scope.allowedHosts), false);
});

test('canonical paths normalize duplicate query ordering and preserve provider scope', () => {
  const first = canonicalizeSourceUrl(createSourceUrl('provider', 'https://allowed.example/a//b/?z=2&a=2&a=1'));
  const second = canonicalizeSourceUrl(createSourceUrl('provider', 'https://ALLOWED.example/a/b?a=1&z=2&a=2'));
  assert.deepEqual(first, second);
  assert.equal(first.providerId, 'provider');
  assert.equal(first.path, '/a/b');
  assert.equal(first.normalizedQuery, 'a=1&a=2&z=2');
});

test('discovery quarantines unsafe identity links before creating canonical observations or jobs', () => {
  const discovery = new Discovery(scope);
  const sourceUrl = createSourceUrl('provider', 'https://allowed.example/cbb/schools/');
  const snapshot = {
    jobKey: 'index', sourceUrl, body: Buffer.from('{}'),
    sourceUrlFrom: (target, base) => createSourceUrl('provider', target, base),
  };
  const result = discovery.discover('school_index', snapshot, {
    schools: [{ path: 'https://blocked.example/school/a', historyUrl: 'https://allowed.example/school/a/men/', to: 2026 }],
  });
  assert.equal(result.childJobs.length, 0);
  assert.equal(result.observations.some((item) => item.kind === 'rejected_url' && /allowlisted/.test(item.reason)), true);

  const gameResult = discovery.discover('game_log', { ...snapshot, jobKey: 'games' }, {
    games: [{ boxScoreUrl: 'https://blocked.example/box/one.html', status: 'final' }],
  });
  assert.equal(gameResult.childJobs.length, 0);
  assert.equal(gameResult.observations.find((item) => item.kind === 'game_log').canonicalBoxScorePath, null);
});
