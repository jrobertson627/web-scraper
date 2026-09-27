# Job lifecycle and fencing

Jobs follow the legal state graph defined in `src/contracts/jobs.mjs`: `pending` or a ready `retry_wait` may be claimed as `fetching`; a successful durable raw commit moves through `fetched` to `parsed`; fetch, parse, or challenge outcomes enter their explicit failure/stop states. Every claim and transition retains its timestamp, attempt count, lease generation, and details.

A claim carries an owner, expiry, and monotonically increasing generation. PostgreSQL stores the next-generation counter separately from the active lease columns so clearing an expired lease cannot reuse a token. Every fetch, parse, page commit, and transition requires the current unexpired token. Expiry alone does not release an active host request: recovery skips the job until the request is released. The owning worker releases it with `releaseRequest` when the response settles, or with `confirmRequestCancellation` when it cancels the transport. Only then can recovery issue the next generation, fencing the stale worker.

A worker that dies mid-request never releases its request, and one-request-per-host would then stall that host forever. Claim recovery therefore releases such requests automatically, with no supervisor or manual step: an unreleased request is canceled with the reason `owner lease expired past request deadline` once both its start and its owner's lease expiry are more than `requestTimeoutMs + orphanGraceMs` in the past on the store clock. That is safe because the transport ends every request within `requestTimeoutMs`, and a live worker renews its lease at least every `claimTimeoutMs / 3` while a request runs, so a request still inside that deadline is never released early and two requests to one host never overlap. The persistence options `requestTimeoutMs` (default 120 s, the largest the request policy allows) and `orphanGraceMs` (default 10 s) must be at least the workers' policy timeout. Normal claim recovery then moves the job to `retry_wait`, charged to `claimRecoveries`.

Child work is claimable only after its recorded parent reaches `parsed`. Replaying a page after a crash is idempotent because job, page, observation, and coverage identities are stable.

Challenge responses enter `operator_stop` and are never retryable by time alone. A configured operator-authorizer must approve a durable `hold`, `release_retry`, or `release_permanent` disposition. Holds preserve the stop; releases record the reviewer and reason before changing state.

## Retry budgets

`attempts` counts every claim and is kept for history only. Whether a job may retry again is decided by three separate counters, each with its own cap:

| Failure | Counter | Cap | When the cap is reached |
| --- | --- | --- | --- |
| Transport error, timeout, 5xx, or an infrastructure error while fetching (raw store write, database call, lease renewal) | `failureAttempts` | request policy `maxAttempts` (3) | `permanently_failed` |
| 429 with a usable `Retry-After` | `rateLimitAttempts` | request policy `maxRateLimitAttempts` (5) | `operator_stop` (`rate_limit_cap`) |
| Claim expired without the job completing (worker crashed or lost its lease) | `claimRecoveries` | persistence option `maxClaimRecoveries` (3) | `permanently_failed` |
| Host busy (another job owns the host's request slot) | none | none | retries after one second |

A cap of N means the Nth charged failure is terminal, so `maxAttempts: 3` allows two retries. The Fetcher and the orchestrator attach `charge: 'failure'` or `charge: 'rate_limit'` to a `retry_wait` transition, and the persistence adapter increments the matching counter in the same write. Claim recovery increments `claimRecoveries` itself. A reviewed `release_retry` resets `rateLimitAttempts` and keeps the other counters.

Claim recovery is not charged to `maxAttempts`, because a crash says nothing about the page, but it is still capped so a page that crashes every worker that touches it cannot loop forever.

An infrastructure error while fetching settles only that job: the orchestrator records a charged `retry_wait` (or `permanently_failed`) and continues with the next job. If the job cannot be settled because its lease is already gone, claim recovery settles it later. Errors marked `fatal`, such as a throttle clock that does not advance, still stop the worker because they are wiring defects rather than page failures.

## Decision: time authority for leases

**Status:** accepted (issue #87).

**Context.** Claims and renewals in PostgreSQL set `claim_expires_at` from `clock_timestamp()`, but the lease check compared that value with the worker process's `new Date()`. The in-memory adapter used whatever time the caller passed in. With several workers on different hosts, skew between a worker clock and the database clock could reject a valid lease or accept an expired one, which breaks fencing, and the two adapters behaved differently.

**Decision.** The persistence store's clock is the only authority for lease validity: the database clock (`clock_timestamp()`) for PostgreSQL, and the adapter's own injected clock for `InMemoryPersistence`.

- Claiming, renewing, checking and recovering a lease, and the readiness of a `retry_wait` job, are decided by the store clock. In PostgreSQL the lease check is part of the SQL (`claim_owner = $n AND lease_generation = $n AND claim_expires_at > clock_timestamp()`), so no comparison ever uses the process clock.
- The `now` arguments to `claimNextJob`, `renewClaim` and `recoverExpiredClaims` remain in the interface for compatibility and are ignored by both adapters.
- Request pacing (`minIntervalMs`, the per-minute window, `Retry-After` and backoff delays) stays on the worker's injected clock. A `nextAllowedAt` computed by the worker is compared with the store clock, so skew shifts a retry by the size of the skew but cannot affect fencing.

**Consequences.** Skew can no longer extend or shorten a lease. Tests that want a lease to expire advance the persistence clock, not the time they pass in. A retry delay is shifted by the skew: a worker clock ahead of the database makes the job wait longer, one behind makes it wait less. The per-host minimum interval is still checked by the worker before every request, and the per-host request lock still prevents overlapping requests, so a shorter retry wait cannot break politeness limits for a single worker. Running several workers with skewed clocks against one host is not supported until pacing also moves to the store clock.
