// The longest whole-request timeout a policy may set. Persistence uses it as
// the default request deadline so it can never release a live request early.
export const MAX_REQUEST_TIMEOUT_MS = 120_000;

export const REQUEST_POLICY_DEFAULTS = Object.freeze({
  requestTimeoutMs: 30_000,
  maxAttempts: 3,
  retryBaseMs: 1_000,
  retryMaxMs: 60_000,
  maxRedirects: 4,
  cacheMaxAgeMs: 0,
  maxResponseBytes: 16 * 1024 * 1024,
  maxRetryAfterMs: 86_400_000,
  maxRateLimitAttempts: 5,
  // A 404 or 410 on a link the site published is retried with a much longer
  // backoff than a transport error: a page that is missing during the site's own
  // deploy is usually back within the hour (#130).
  notFoundRetryBaseMs: 900_000,
  notFoundRetryMaxMs: 7_200_000,
});

// Retry budgets (see JOB_LIFECYCLE.md):
// - transport errors, 5xx responses, 404/410 responses and fetch-phase
//   infrastructure errors are charged to job.failureAttempts and capped by
//   policy.maxAttempts;
// - 429 responses are charged to job.rateLimitAttempts and capped by
//   policy.maxRateLimitAttempts, which escalates to operator_stop;
// - host-busy waits and claim recovery are never charged to either budget.
// A retry_wait result carries `charge`, which the persistence transition uses
// to increment the matching counter.

// The outcome of a failure charged to policy.maxAttempts: a retry_wait with
// bounded exponential backoff, or permanently_failed once the budget is spent.
export function chargedRetry(policy, job, reason, code, now, { baseMs = policy.retryBaseMs, maxMs = policy.retryMaxMs } = {}) {
  const attempt = (job.failureAttempts ?? 0) + 1;
  if (attempt >= policy.maxAttempts) return { kind: 'permanently_failed', code, reason: `${reason}; retry limit reached` };
  const delay = Math.min(baseMs * (2 ** (attempt - 1)), maxMs);
  return { kind: 'retry_wait', code, reason, charge: 'failure', nextAllowedAt: new Date(now.getTime() + delay).toISOString() };
}

// The outcome of a 404 or 410: a charged retry on the long not-found backoff,
// permanently_failed only once policy.maxAttempts is spent.
export function notFoundRetry(policy, job, status, now) {
  return chargedRetry(policy, job, `upstream ${status}`, 'not_found', now, { baseMs: policy.notFoundRetryBaseMs, maxMs: policy.notFoundRetryMaxMs });
}

// The outcome of a 429 with a usable Retry-After: a retry_wait charged to the
// rate-limit budget, or operator_stop once that budget is spent.
export function rateLimitedRetry(policy, job, nextAllowedAt) {
  const attempt = (job.rateLimitAttempts ?? 0) + 1;
  if (attempt >= policy.maxRateLimitAttempts) {
    return { kind: 'operator_stop', code: 'rate_limit_cap', reason: `rate limited ${attempt} times; operator review required` };
  }
  return { kind: 'retry_wait', reason: 'rate limited', charge: 'rate_limit', nextAllowedAt };
}

function invalid(field, expected, example) {
  throw new Error(`${field} is invalid. Expected ${expected}. Example: ${example}`);
}

export function validateRequestPolicy(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('policy', 'a request policy object', 'policy: { minIntervalMs: 6000 }');
  const policy = { ...REQUEST_POLICY_DEFAULTS, ...input };
  if (!Number.isFinite(policy.minIntervalMs) || policy.minIntervalMs < 6_000) invalid('policy.minIntervalMs', 'at least 6000 milliseconds', 'minIntervalMs: 6000');
  if (!Number.isInteger(policy.maxRequestsPerMinute) || policy.maxRequestsPerMinute < 1 || policy.maxRequestsPerMinute > 10) invalid('policy.maxRequestsPerMinute', 'an integer from 1 through 10', 'maxRequestsPerMinute: 10');
  if (policy.hostConcurrency !== 1) invalid('policy.hostConcurrency', 'one request per host', 'hostConcurrency: 1');
  // Requires a leading application name followed by an operator contact
  // email in parens, e.g. "scraper (+ops@example.com)" or
  // "web-scraper-fixture (+local@example.com)". The parenthesized group
  // must contain an @ with a dotted domain and no nested parens.
  if (typeof policy.userAgent !== 'string' || !/\S+.*\([^()\s]+@[^()\s]+\.[^()\s]+\)/.test(policy.userAgent)) invalid('policy.userAgent', 'an application name and operator contact address', 'userAgent: scraper (+ops@example.com)');
  for (const [field, min, max] of [
    ['requestTimeoutMs', 1_000, MAX_REQUEST_TIMEOUT_MS], ['maxAttempts', 1, 10], ['retryBaseMs', 100, 60_000],
    ['retryMaxMs', 100, 600_000], ['maxRedirects', 0, 10], ['cacheMaxAgeMs', 0, 86_400_000],
    ['maxResponseBytes', 1_024, 64 * 1024 * 1024], ['maxRetryAfterMs', 6_000, 7 * 86_400_000],
    ['maxRateLimitAttempts', 1, 50], ['notFoundRetryBaseMs', 1_000, 86_400_000], ['notFoundRetryMaxMs', 1_000, 86_400_000],
  ]) {
    if (!Number.isSafeInteger(policy[field]) || policy[field] < min || policy[field] > max) invalid(`policy.${field}`, `an integer from ${min} through ${max}`, `${field}: ${REQUEST_POLICY_DEFAULTS[field]}`);
  }
  if (policy.retryMaxMs < policy.retryBaseMs) invalid('policy.retryMaxMs', 'at least policy.retryBaseMs', 'retryMaxMs: 60000');
  if (policy.notFoundRetryMaxMs < policy.notFoundRetryBaseMs) invalid('policy.notFoundRetryMaxMs', 'at least policy.notFoundRetryBaseMs', 'notFoundRetryMaxMs: 7200000');
  if (policy.maxRetryAfterMs < policy.minIntervalMs) invalid('policy.maxRetryAfterMs', 'at least policy.minIntervalMs', 'maxRetryAfterMs: 86400000');
  return Object.freeze(policy);
}
