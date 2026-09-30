export const JOB_STATES = Object.freeze([
  'pending', 'fetching', 'fetched', 'parsed', 'retry_wait', 'permanently_failed', 'parse_failed', 'operator_stop',
]);

export const FAILURE_STATES = Object.freeze(['retry_wait', 'operator_stop', 'parse_failed', 'permanently_failed']);

const TRANSITIONS = new Map([
  ['pending', new Set(['fetching'])],
  ['fetching', new Set(['fetched', 'retry_wait', 'permanently_failed', 'parse_failed', 'operator_stop'])],
  // fetched -> permanently_failed is only taken by claim recovery once a job
  // has exhausted its claim-recovery budget.
  ['fetched', new Set(['parsed', 'parse_failed', 'retry_wait', 'operator_stop', 'permanently_failed'])],
  ['retry_wait', new Set(['fetching', 'permanently_failed'])],
  ['operator_stop', new Set(['retry_wait', 'permanently_failed'])],
  ['parsed', new Set()],
  // Only offline reprocessing takes parse_failed -> parsed, when a fixed parser
  // reads the stored snapshot. It holds no lease; a worker never claims a
  // parse_failed job, and transitionJob needs a lease, so no worker can.
  ['parse_failed', new Set(['parsed'])],
  ['permanently_failed', new Set()],
]);

// Settled states whose stored snapshot offline reprocessing may parse again.
export const REPROCESS_STATES = Object.freeze(['parsed', 'parse_failed']);

// Both persistence adapters apply this cap when recovering jobs whose worker
// disappeared: a job whose claim expires this many times without completing
// becomes permanently_failed instead of retry_wait. Claim recovery never draws
// on the transport/5xx budget (policy.maxAttempts). See JOB_LIFECYCLE.md.
export const DEFAULT_MAX_CLAIM_RECOVERIES = 3;

// An unreleased host request is orphaned (its worker died mid-request) once
// both its start and its owner's lease expiry are more than the request
// timeout plus this grace in the past. The worker renews its lease at least
// every claimTimeoutMs / 3 while a request runs and the transport ends every
// request within requestTimeoutMs, so no live request can still be running
// by then. Both adapters then cancel it with ORPHANED_REQUEST_REASON.
export const DEFAULT_ORPHAN_GRACE_MS = 10_000;
export const ORPHANED_REQUEST_REASON = 'owner lease expired past request deadline';

// PostgreSQL errors that say nothing about the page: serialization failures
// (40001), deadlocks (40P01), connection exceptions (class 08), an
// administrator shutdown (57P01), a statement timeout (57014), too many
// connections (53300) and a server that cannot accept connections yet (57P03),
// plus a socket dropped under the driver. A page commit that fails this way is
// retried rather than recorded as parse_failed, and the run loop retries the
// same errors from claiming a job before it gives up (#122).
const TRANSIENT_STORE_CODES = new Set(['40001', '40P01', '57P01', '57014', '53300', '57P03', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT']);

// Out of disk (53100) or out of memory (53200) on the database server. Retrying
// does not help until someone acts, so it is systemic, not a page failure: the
// run halts (#114, #122).
const SYSTEMIC_STORE_CODES = new Set(['53100', '53200']);

export function isSystemicStoreError(error, seen = new Set()) {
  if (!error || typeof error !== 'object' || seen.has(error)) return false;
  seen.add(error);
  if (SYSTEMIC_STORE_CODES.has(typeof error.code === 'string' ? error.code : '')) return true;
  return isSystemicStoreError(error.cause, seen) || (error.errors ?? []).some((inner) => isSystemicStoreError(inner, seen));
}

export function isTransientStoreError(error, seen = new Set()) {
  if (!error || typeof error !== 'object' || seen.has(error)) return false;
  seen.add(error);
  const code = typeof error.code === 'string' ? error.code : '';
  if (TRANSIENT_STORE_CODES.has(code) || /^08[0-9A-Z]{3}$/.test(code)) return true;
  if (/^Connection terminated\b/.test(error.message ?? '')) return true;
  return isTransientStoreError(error.cause, seen) || (error.errors ?? []).some((inner) => isTransientStoreError(inner, seen));
}

export function positiveInteger(name, value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

export function canTransition(from, to) {
  return TRANSITIONS.get(from)?.has(to) ?? false;
}

export function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    throw new Error(`illegal job transition: ${from} -> ${to}. Expected a legal durable transition from the current state.`);
  }
}

export function createLeaseToken(workerId, generation = 1) {
  if (!workerId || !Number.isInteger(generation) || generation < 1) {
    throw new Error('lease token requires a workerId and positive integer generation');
  }
  return Object.freeze({ workerId, generation, value: `${workerId}:${generation}` });
}

export function sameLease(left, right) {
  return Boolean(left && right && left.value === right.value);
}

// Operator-stop codes that halt the whole run, not just the page: the site is
// refusing the crawler, so no further request is made until an operator has
// reviewed the stop. A challenge (403 or a challenge page); a 429 with no usable
// Retry-After, or one longer than the policy allows, so there is no telling when
// it is safe to go on; and a page that reached its rate-limit cap (#113).
export const HALTING_STOP_CODES = Object.freeze(['challenge', 'invalid_retry_after', 'retry_after_too_long', 'rate_limit_cap']);

// How long the worker waits before looking again when another request holds the
// host (an orphan from a crashed worker, or a second worker), instead of
// claiming and settling one job after another (#118).
export const HOST_BUSY_WAIT_MS = 5_000;

// The persistence adapters' default operator authorizer: nobody may record a
// disposition until the process supplies one (src/config/operators.mjs, #48).
export const DENY_ALL_OPERATORS = Object.freeze(() => false);

// Jobs an operator reviews (#48): stopped for a challenge or a cap, or failed
// to parse.
export const REVIEW_JOB_STATES = Object.freeze(['parse_failed', 'operator_stop']);

// A disposition of a reconciliation issue: accept its quarantined revision, or
// dismiss it and keep the accepted record. Same shape as an operator-stop
// disposition.
export function createReviewDisposition(kind, operatorId, reason, at = new Date()) {
  if (!['accept', 'dismiss'].includes(kind)) {
    throw new Error(`invalid review disposition: ${kind}. Expected accept or dismiss. Example: dismiss`);
  }
  if (!operatorId || !reason) {
    throw new Error('review disposition requires operatorId and reason. Example: operatorId: ops-1, reason: source corrected the score');
  }
  return Object.freeze({ kind, operatorId, reason, at: new Date(at).toISOString() });
}

export function createOperatorDisposition(kind, operatorId, reason, at) {
  if (!['hold', 'release_retry', 'release_permanent'].includes(kind)) {
    throw new Error(`invalid operator disposition: ${kind}. Expected hold, release_retry, or release_permanent. Example: release_retry`);
  }
  if (!operatorId || !reason) {
    throw new Error('operator disposition requires operatorId and reason. Example: operatorId: ops-1, reason: reviewed');
  }
  return Object.freeze({ kind, operatorId, reason, at: at.toISOString() });
}

export function createJobStateEvent({ from, to, at, attempts, lease, details = {} }) {
  if (!JOB_STATES.includes(from) || !JOB_STATES.includes(to) || !at) {
    throw new Error('job state event requires legal from/to states and a timestamp');
  }
  return Object.freeze({
    from,
    to,
    at: new Date(at).toISOString(),
    attempts,
    leaseGeneration: lease?.generation ?? null,
    details: Object.freeze({ ...details }),
  });
}
