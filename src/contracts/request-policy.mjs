export const REQUEST_POLICY_DEFAULTS = Object.freeze({
  requestTimeoutMs: 30_000,
  maxAttempts: 3,
  retryBaseMs: 1_000,
  retryMaxMs: 60_000,
  maxRedirects: 4,
  cacheMaxAgeMs: 0,
});

function invalid(field, expected, example) {
  throw new Error(`${field} is invalid. Expected ${expected}. Example: ${example}`);
}

export function validateRequestPolicy(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('policy', 'a request policy object', 'policy: { minIntervalMs: 6000 }');
  const policy = { ...REQUEST_POLICY_DEFAULTS, ...input };
  if (!Number.isFinite(policy.minIntervalMs) || policy.minIntervalMs < 6_000) invalid('policy.minIntervalMs', 'at least 6000 milliseconds', 'minIntervalMs: 6000');
  if (!Number.isInteger(policy.maxRequestsPerMinute) || policy.maxRequestsPerMinute < 1 || policy.maxRequestsPerMinute > 10) invalid('policy.maxRequestsPerMinute', 'an integer from 1 through 10', 'maxRequestsPerMinute: 10');
  if (policy.hostConcurrency !== 1) invalid('policy.hostConcurrency', 'one request per host', 'hostConcurrency: 1');
  if (typeof policy.userAgent !== 'string' || !/\S+.*\([^()\s]+@[^()\s]+\.[^()\s]+\)/.test(policy.userAgent)) invalid('policy.userAgent', 'an application name and operator contact address', 'userAgent: scraper (+ops@example.com)');
  for (const [field, min, max] of [
    ['requestTimeoutMs', 1_000, 120_000], ['maxAttempts', 1, 10], ['retryBaseMs', 100, 60_000],
    ['retryMaxMs', 100, 600_000], ['maxRedirects', 0, 10], ['cacheMaxAgeMs', 0, 86_400_000],
  ]) {
    if (!Number.isSafeInteger(policy[field]) || policy[field] < min || policy[field] > max) invalid(`policy.${field}`, `an integer from ${min} through ${max}`, `${field}: ${REQUEST_POLICY_DEFAULTS[field]}`);
  }
  if (policy.retryMaxMs < policy.retryBaseMs) invalid('policy.retryMaxMs', 'at least policy.retryBaseMs', 'retryMaxMs: 60000');
  return Object.freeze(policy);
}
