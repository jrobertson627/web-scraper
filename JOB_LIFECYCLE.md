# Job lifecycle and fencing

Jobs follow the legal state graph defined in `src/contracts/jobs.mjs`: `pending` or a ready `retry_wait` may be claimed as `fetching`; a successful durable raw commit moves through `fetched` to `parsed`; fetch, parse, or challenge outcomes enter their explicit failure/stop states. Every claim and transition retains its timestamp, attempt count, lease generation, and details.

A claim carries an owner, expiry, and monotonically increasing generation. PostgreSQL stores the next-generation counter separately from the active lease columns so clearing an expired lease cannot reuse a token. Every fetch, parse, page commit, and transition requires the current unexpired token. Expiry alone does not release an active host request: recovery skips the job until response completion calls `releaseRequest`, or a supervisor confirms transport cancellation through `confirmRequestCancellation`. Only then can recovery issue the next generation, fencing the stale worker.

Child work is claimable only after its recorded parent reaches `parsed`. Replaying a page after a crash is idempotent because job, page, observation, and coverage identities are stable.

Challenge responses enter `operator_stop` and are never retryable by time alone. A configured operator-authorizer must approve a durable `hold`, `release_retry`, or `release_permanent` disposition. Holds preserve the stop; releases record the reviewer and reason before changing state.

## Decision: time authority for leases

**Status:** accepted (issue #87).

**Context.** Claims and renewals in PostgreSQL set `claim_expires_at` from `clock_timestamp()`, but the lease check compared that value with the worker process's `new Date()`. The in-memory adapter used whatever time the caller passed in. With several workers on different hosts, skew between a worker clock and the database clock could reject a valid lease or accept an expired one, which breaks fencing, and the two adapters behaved differently.

**Decision.** The persistence store's clock is the only authority for lease validity: the database clock (`clock_timestamp()`) for PostgreSQL, and the adapter's own injected clock for `InMemoryPersistence`.

- Claiming, renewing, checking and recovering a lease, and the readiness of a `retry_wait` job, are decided by the store clock. In PostgreSQL the lease check is part of the SQL (`claim_owner = $n AND lease_generation = $n AND claim_expires_at > clock_timestamp()`), so no comparison ever uses the process clock.
- The `now` arguments to `claimNextJob`, `renewClaim` and `recoverExpiredClaims` remain in the interface for compatibility and are ignored by both adapters.
- Request pacing (`minIntervalMs`, the per-minute window, `Retry-After` and backoff delays) stays on the worker's injected clock. A `nextAllowedAt` computed by the worker is compared with the store clock, so skew shifts a retry by the size of the skew but cannot affect fencing.

**Consequences.** Skew can no longer extend or shorten a lease. Tests that want a lease to expire advance the persistence clock, not the time they pass in. A retry delay is shifted by the skew: a worker clock ahead of the database makes the job wait longer, one behind makes it wait less. The per-host minimum interval is still checked by the worker before every request, and the per-host request lock still prevents overlapping requests, so a shorter retry wait cannot break politeness limits for a single worker. Running several workers with skewed clocks against one host is not supported until pacing also moves to the store clock.
