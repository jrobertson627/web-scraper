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
  ['parse_failed', new Set()],
  ['permanently_failed', new Set()],
]);

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
