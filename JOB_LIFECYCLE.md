# Job lifecycle and fencing

Jobs follow the legal state graph defined in `src/contracts/jobs.mjs`: `pending` or a ready `retry_wait` may be claimed as `fetching`; a successful durable raw commit moves through `fetched` to `parsed`; fetch, parse, or challenge outcomes enter their explicit failure/stop states. Every claim and transition retains its timestamp, attempt count, lease generation, and details.

A claim carries an owner, expiry, and monotonically increasing generation. Every fetch, parse, page commit, and transition requires the current unexpired token. Expiry alone does not release an active host request: recovery skips the job until response completion calls `releaseRequest`, or a supervisor confirms transport cancellation through `confirmRequestCancellation`. Only then can recovery issue the next generation, fencing the stale worker.

Child work is claimable only after its recorded parent reaches `parsed`. Replaying a page after a crash is idempotent because job, page, observation, and coverage identities are stable.

Challenge responses enter `operator_stop` and are never retryable by time alone. A configured operator-authorizer must approve a durable `hold`, `release_retry`, or `release_permanent` disposition. Holds preserve the stop; releases record the reviewer and reason before changing state.
