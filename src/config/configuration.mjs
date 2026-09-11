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
  const policy = config.policy;
  if (!policy || !Number.isFinite(policy.minIntervalMs) || policy.minIntervalMs < 6000) {
    throw configError('policy.minIntervalMs', 'is invalid', 'Expected a finite value of at least 6000 milliseconds (six seconds)', 'minIntervalMs: 6000');
  }
  if (!Number.isFinite(policy.maxRequestsPerMinute) || policy.maxRequestsPerMinute < 1 || policy.maxRequestsPerMinute > 10) {
    throw configError('policy.maxRequestsPerMinute', 'is invalid', 'Expected a finite value from 1 through 10 requests per minute', 'maxRequestsPerMinute: 10');
  }
  if (policy.hostConcurrency !== 1) {
    throw configError('policy.hostConcurrency', 'must be one', 'Expected one sequential request for the host', 'hostConcurrency: 1');
  }
  if (typeof policy.userAgent !== 'string' || !policy.userAgent.includes('@')) {
    throw configError('policy.userAgent', 'must include an operator contact address', 'Expected a transparent application name and contact', 'userAgent: scraper (+ops@example.com)');
  }
  if (!Array.isArray(config.allowedHosts) || config.allowedHosts.length === 0 ||
      config.allowedHosts.some((host) => typeof host !== 'string' || !host || host.includes('/') || host.includes(':'))) {
    throw configError('allowedHosts', 'is invalid', 'Expected host names without schemes, paths, or ports', 'allowedHosts: [provider.example]');
  }
  if (typeof config.providerId !== 'string' || !config.providerId) {
    throw configError('providerId', 'is missing', 'Expected a non-empty provider identifier', 'providerId: provider');
  }
  if (config.eligibilityPredicate !== REQUIRED_ELIGIBILITY_PREDICATE) {
    throw configError('eligibilityPredicate', `is invalid: ${config.eligibilityPredicate}`, `Expected exactly ${REQUIRED_ELIGIBILITY_PREDICATE}`, `eligibilityPredicate: '${REQUIRED_ELIGIBILITY_PREDICATE}'`);
  }
  const years = [...(config.targetEndingYears ?? [])].sort((a, b) => a - b);
  if (JSON.stringify(years) !== JSON.stringify(TARGET_ENDING_YEARS)) {
    throw configError('targetEndingYears', `is invalid: ${JSON.stringify(config.targetEndingYears)}`, `Expected exactly ${JSON.stringify(TARGET_ENDING_YEARS)}`, 'targetEndingYears: [2022, 2023, 2024, 2025, 2026]');
  }
  if (!['memory', 'filesystem'].includes(config.rawStore)) {
    throw configError('rawStore', `is invalid: ${config.rawStore}`, 'Expected memory or filesystem', 'rawStore: memory');
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
