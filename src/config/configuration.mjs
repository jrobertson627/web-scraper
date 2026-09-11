import { REQUIRED_ELIGIBILITY_PREDICATE, TARGET_ENDING_YEARS } from '../contracts/source.mjs';
import { requireAuthorization } from './authorization.mjs';

function configError(field, problem, expected, example) {
  return new Error(`${field} ${problem}. ${expected}. Example: ${example}`);
}

export function validateConfiguration(input) {
  const config = structuredClone(input);
  if (!['local', 'worker', 'api'].includes(config.mode)) {
    throw configError('mode', `is invalid: ${config.mode}`, 'Expected local, worker, or api', 'mode: local');
  }
  if (config.policy?.minIntervalMs < 6000) {
    throw configError('policy.minIntervalMs', 'is too small', 'Expected at least 6000 milliseconds (six seconds)', 'minIntervalMs: 6000');
  }
  if (config.policy?.maxRequestsPerMinute > 10) {
    throw configError('policy.maxRequestsPerMinute', 'is too large', 'Expected no more than 10 requests per minute', 'maxRequestsPerMinute: 10');
  }
  if (config.policy?.hostConcurrency !== 1) {
    throw configError('policy.hostConcurrency', 'must be one', 'Expected one sequential request for the host', 'hostConcurrency: 1');
  }
  if (!config.policy?.userAgent?.includes('@')) {
    throw configError('policy.userAgent', 'must include an operator contact address', 'Expected a transparent application name and contact', 'userAgent: scraper (+ops@example.com)');
  }
  if (!Array.isArray(config.allowedHosts) || config.allowedHosts.length === 0) {
    throw configError('allowedHosts', 'is missing', 'Expected at least one configured HTTPS host', 'allowedHosts: [provider.example]');
  }
  if (config.eligibilityPredicate !== REQUIRED_ELIGIBILITY_PREDICATE) {
    throw configError('eligibilityPredicate', `is invalid: ${config.eligibilityPredicate}`, `Expected exactly ${REQUIRED_ELIGIBILITY_PREDICATE}`, `eligibilityPredicate: '${REQUIRED_ELIGIBILITY_PREDICATE}'`);
  }
  const years = [...(config.targetEndingYears ?? [])].sort((a, b) => a - b);
  if (JSON.stringify(years) !== JSON.stringify(TARGET_ENDING_YEARS)) {
    throw configError('targetEndingYears', `is invalid: ${JSON.stringify(config.targetEndingYears)}`, `Expected exactly ${JSON.stringify(TARGET_ENDING_YEARS)}`, `targetEndingYears: [2022, 2023, 2024, 2025, 2026]`);
  }
  if (!config.rawStore) {
    throw configError('rawStore', 'is missing', 'Expected an immutable raw-object store', 'rawStore: memory');
  }
  if (config.mode === 'worker') requireAuthorization(config.authorization, config.providerId, 'crawl');
  if (config.mode === 'api' && config.publication === 'public') requireAuthorization(config.authorization, config.providerId, 'publish');
  return deepFreeze(config);
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
