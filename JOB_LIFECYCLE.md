# Job lifecycle and fencing

Jobs follow the legal state graph defined in `src/contracts/jobs.mjs`: `pending` or a ready `retry_wait` may be claimed as `fetching`; a successful durable raw commit moves through `fetched` to `parsed`; fetch, parse, or challenge outcomes enter their explicit failure/stop states. Every claim and transition retains its timestamp, attempt count, lease generation, and details.

A claim carries an owner, expiry, and monotonically increasing generation. PostgreSQL stores the next-generation counter separately from the active lease columns so clearing an expired lease cannot reuse a token. Every fetch, parse, page commit, and transition requires the current unexpired token. Expiry alone does not release an active host request: recovery skips the job until the request is released. The owning worker releases it with `releaseRequest` when the response settles, or with `confirmRequestCancellation` when it cancels the transport. Only then can recovery issue the next generation, fencing the stale worker.

A worker that dies mid-request never releases its request, and one-request-per-host would then stall that host forever. Claim recovery therefore releases such requests automatically, with no supervisor or manual step: an unreleased request is canceled with the reason `owner lease expired past request deadline` once both its start and its owner's lease expiry are more than `requestTimeoutMs + orphanGraceMs` in the past on the store clock. That is safe because the transport ends every request within `requestTimeoutMs`, and a live worker renews its lease at least every `claimTimeoutMs / 3` while a request runs, so a request still inside that deadline is never released early and two requests to one host never overlap. The persistence options `requestTimeoutMs` (default 120 s, the largest the request policy allows) and `orphanGraceMs` (default 10 s) must be at least the workers' policy timeout. Normal claim recovery then moves the job to `retry_wait`, charged to `claimRecoveries`.

`parse_failed` is terminal for the worker: it is never claimed or retried by time. The one way out is offline reprocessing (`npm run reprocess`, see `PARSER_NORMALIZATION.md`): when a fixed parser reads the stored snapshot and its page is accepted, the job moves `parse_failed -> parsed` with the event details `{ reprocessed: true, parserVersion }`, and the child jobs its page links to are queued. That transition takes no lease, and `transitionJob` needs one, so no worker can take it.

Child work is claimable only after its recorded parent reaches `parsed`. Replaying a page after a crash is idempotent because job, page, observation, and coverage identities are stable.

Challenge responses enter `operator_stop` and are never retryable by time alone. A configured operator-authorizer must approve a durable `hold`, `release_retry`, or `release_permanent` disposition. Holds preserve the stop; releases record the reviewer and reason before changing state. Both persistence adapters deny every operator by default; see [Operator review](#operator-review).

## Operator review

`npm run review` (or `npm run review:personal`) is how an operator finds, inspects and acts on what the crawl stopped for, without touching the database (#48). It reads `PERSISTENCE=postgres` and builds no transport.

```sh
npm run review -- list                      # jobs to review and open issues (--jobs, --issues, --state, --limit, --json)
npm run review -- show <job key | issue id> # everything recorded about one item, with next steps
npm run review -- hold|release-retry|release-permanent <job key> --operator <id> --reason "<why>"
npm run review -- requeue <job key> --operator <id> --reason "<why>"   # a permanently_failed page, with a fresh budget
npm run review -- release-retry|requeue --state <state> --code <code> --operator <id> --reason "<why>" [--dry-run]   # every job in that state whose latest stop carries that code
npm run review -- release-halt <halt id> --operator <id> --reason "<why>"   # a halt of the whole run
npm run review -- accept|dismiss <issue id> --operator <id> --reason "<why>"
```

- **Jobs** in `parse_failed` or `operator_stop` are listed with their page type, URL and reason. `show` adds the latest parse run (parser version, warnings, failure details), the stored raw snapshot (checksum, object path, fetch time), the state history, and earlier dispositions.
  - An `operator_stop` job is held or released here.
  - A `permanently_failed` job is listed only when asked for (`--state permanently_failed`), since the default list is what needs a decision. `requeue` puts it back in `retry_wait` with `failureAttempts`, `rateLimitAttempts` and `claimRecoveries` reset to zero, recorded like any disposition (`requeue_failed`). It is the only way out of `permanently_failed`, and it works on a page whose subtree was never queued: the pages under it are queued when it parses. Each failure records its `code` (`transient_network`, `upstream_5xx`, `not_found`, ...), so `--code` requeues every page that failed the same way.
  - A `parse_failed` job is fixed with a new parser version and `npm run reprocess -- --job <key>`, which re-parses the stored snapshot without a request (`PARSER_NORMALIZATION.md`).
- **Open reconciliation issues** are listed with the fields that differ.
  - A `conflicting_page_reprocess` issue holds a quarantined revision whose raw body differs from the accepted record's. `accept` makes that revision the accepted record; `dismiss` keeps the accepted one.
  - Any other issue (for example `conflicting_game_log_fact`) can only be dismissed.

**Authorization.** A disposition needs `--operator <id>` and `--reason`, and the id must be in `OPERATOR_IDS`, a comma-separated allowlist of reviewers. Without `OPERATOR_IDS` nobody may act. The persistence adapters enforce the same allowlist, and default to denying everyone when none is given. The allowlist names reviewers; it does not authenticate them. Anyone who can run the command already holds the database credentials, so the credentials are the real gate, and the allowlist makes every recorded "who" a named reviewer.

**Records.** Every disposition is recorded with who, when and why:
- `operator_dispositions` (hold and the two releases);
- `reconciliation_dispositions` (accept, with the revision that became accepted, and dismiss).

An issue moves from `open` to `accepted` or `resolved`.

**Accepting a revision** derives the page again from that revision's own stored snapshot, with the parser version that produced it, and requires it to normalize to exactly the data under review. It then commits the page as the accepted record, closes the issue and records the disposition, all in one transaction. Because the page is derived again, its observations and child links are committed as well; a current-season game log that gained box-score links queues them. The new rows replace the old record's rows, as a superseding revision's do. Accept is refused in three cases:
- the accepted record changed since the issue opened (dismiss the stale issue and review the current one);
- the snapshot no longer normalizes to the reviewed data (the parser or the data contract changed since);
- the job is not settled.

`accept` also needs the worker configuration (authorization, data contract, `RAW_STORE_ROOT`, `USER_AGENT`), as reprocessing does.

## Retry budgets

`attempts` counts every claim and is kept for history only. Whether a job may retry again is decided by three separate counters, each with its own cap:

| Failure | Counter | Cap | When the cap is reached |
| --- | --- | --- | --- |
| Transport error, timeout, 5xx, or an infrastructure error while fetching (raw store write, database call, lease renewal) | `failureAttempts` | request policy `maxAttempts` (3) | `permanently_failed` |
| 404 or 410 on a link the site published | `failureAttempts` (same budget) | request policy `maxAttempts` (3), with a `notFoundRetryBaseMs` (15 min) backoff doubling to `notFoundRetryMaxMs` (2 h) | `permanently_failed` |
| 429 with a usable `Retry-After` | `rateLimitAttempts` | request policy `maxRateLimitAttempts` (5) | `operator_stop` (`rate_limit_cap`) |
| Claim expired without the job completing (worker crashed or lost its lease) | `claimRecoveries` | persistence option `maxClaimRecoveries` (3) | `permanently_failed` |
| Host busy (another request holds the host's request slot) | none | none | the worker waits, in steps of five seconds, for the request to finish or its orphan deadline to pass, and claims nothing meanwhile (#118). If the slot is taken after the check, the job is retried after one second, uncharged |
| Host paused after a 429 with a valid `Retry-After` | none | none | the worker waits for the pause (`host_request_schedule.paused_until`) to end; if a job is claimed inside the window anyway, it is retried at that time, uncharged (#113) |

A cap of N means the Nth charged failure is terminal, so `maxAttempts: 3` allows two retries. The Fetcher and the orchestrator attach `charge: 'failure'` or `charge: 'rate_limit'` to a `retry_wait` transition, and the persistence adapter increments the matching counter in the same write. Claim recovery increments `claimRecoveries` itself. A reviewed `release_retry` resets `rateLimitAttempts` and keeps the other counters.

Claim recovery is not charged to `maxAttempts`, because a crash says nothing about the page, but it is still capped so a page that crashes every worker that touches it cannot loop forever.

An infrastructure error while fetching settles only that job: the orchestrator records a charged `retry_wait` (or `permanently_failed`) and continues with the next job. If the job cannot be settled because its lease is already gone, claim recovery settles it later. Errors marked `fatal`, such as a throttle clock that does not advance, still stop the worker because they are wiring defects rather than page failures.

## Long-running worker

`IngestionOrchestrator.run` (used by worker mode through `runWorkerLoop`) keeps claiming until no runnable work remains. When nothing is claimable it asks persistence for `workOutlook()`: the number of `pending`, `retry_wait`, `fetching` and `fetched` jobs that can still run without an operator, and how long until the earliest retry falls due or claim expires (store clock). It sleeps that long, bounded by `maxIdleMs` (30 s) and `minIdleMs` (250 ms), then tries again; it returns once nothing runnable remains. Jobs below a parent in `operator_stop`, `parse_failed` or `permanently_failed` do not keep the worker alive; after an operator releases such a parent, start the worker again. The run returns job counts by state and outcome counts by kind, never the full job list.

**A challenge halts the run.** A job that ends in `operator_stop` with a halting code (`HALTING_STOP_CODES` in `src/contracts/jobs.mjs`: `challenge`, a 403 or a challenge page; `invalid_retry_after` and `retry_after_too_long`, a 429 with no usable `Retry-After`; and `rate_limit_cap`) ends the run after that job: the result has `stopped: true`, `stopReason` set to the code and `halt`, and the crawl log gets a `run.halted` line. Worker mode then exits `6`. A run also halts before claiming anything while any challenge stop is unreviewed, so a restarted worker or an operator trigger makes no request either (`unreviewedChallenges` in both adapters). A stop is unreviewed while its job is still in `operator_stop` and no `hold` was recorded after its latest release; a release moves the job out of `operator_stop`. Ordering uses each job's own history (PostgreSQL: disposition ids), not clocks. Other stops, such as a rate-limit cap, stop only their page. `stopReason` is `'signal'` for SIGTERM or SIGINT, and `null` when the run finished its work.

**Failures that are the crawl's, not the page's (#114).** A transport error, a 5xx or an infrastructure error is charged to the page it happened on, until several happen in a row across different pages. `HealthMonitor` (`src/application/health-monitor.mjs`) counts them: after three in a row across at least two pages it stops charging, puts the failing page back uncharged, and pauses the run for 5 minutes. After a pause one request probes; a failure re-opens the pause at once and doubles it (10 minutes, 20, 40, capped at 2 hours), and a success closes it. Five pauses in a row with no success halt the run (`systemic_failures`). A page fetched and parsed resets the count. A 404, a 429 and a parse failure are not counted. The first one or two failures before a pause have been charged, once each.

These halts are also durable. `run_halts` (migration 016) holds a halt of the whole run, and a run refuses to start while one is unreleased, exactly as for a challenge stop: `systemic_failures`, `raw_store_write_failed` (`ENOSPC`, `EDQUOT` or `EROFS` from a raw-store write, which puts the page back uncharged), `raw_disk_low` (less than `RAW_MIN_FREE_BYTES`, default 512 MiB, free on the raw disk, checked before each request) and, best effort, `database_storage_full`. `npm run review -- list` shows them and `release-halt <id>` releases one, recorded with who and why. The worker's retry policy is `maxAttempts: 5` with 1, 2, 4 and 8 minute backoffs, so a page that genuinely fails on its own takes about 15 minutes to give up.

**A database outage is waited out, or halts the run (#122).** `isTransientStoreError` covers serialization failures, deadlocks, connection errors, a server shutdown, a dropped socket, a statement timeout (`57014`), too many connections (`53300`) and a server that cannot accept connections yet (`57P03`). A page commit that fails with one becomes a retry, not `parse_failed`. The run loop also retries these errors from claiming work, the work outlook and the host gate, backing off from 1 s to 60 s over up to 10 tries (about three and a half minutes, `storeRetry` on the orchestrator), logging `store.retrying` each time, so a short outage pauses the run and it continues without a restart. Any other error, or an outage that outlasts the tries, ends the run as before. Out of disk (`53100`) or memory (`53200`) on the database is not waited out: the page is put back uncharged and the run halts with `stopReason: 'database_storage_full'` and no job, so the worker exits `6` with the reason; free space and restart it.

On SIGTERM or SIGINT the worker stops claiming. The current job settles normally: a request already on the wire finishes (the transport bounds it by `requestTimeoutMs`) and its page is committed; a request that has not started yet, including one waiting for the host's pacing window, is skipped as an uncharged `retry_wait`. Either way the host request is released before the process exits, so no job is left in `fetching`.

## Decision: time authority for leases

**Status:** accepted (issue #87).

**Context.** Claims and renewals in PostgreSQL set `claim_expires_at` from `clock_timestamp()`, but the lease check compared that value with the worker process's `new Date()`. The in-memory adapter used whatever time the caller passed in. With several workers on different hosts, skew between a worker clock and the database clock could reject a valid lease or accept an expired one, which breaks fencing, and the two adapters behaved differently.

**Decision.** The persistence store's clock is the only authority for lease validity: the database clock (`clock_timestamp()`) for PostgreSQL, and the adapter's own injected clock for `InMemoryPersistence`.

- Claiming, renewing, checking and recovering a lease, and the readiness of a `retry_wait` job, are decided by the store clock. In PostgreSQL the lease check is part of the SQL (`claim_owner = $n AND lease_generation = $n AND claim_expires_at > clock_timestamp()`), so no comparison ever uses the process clock.
- The `now` arguments to `claimNextJob`, `renewClaim` and `recoverExpiredClaims` remain in the interface for compatibility and are ignored by both adapters.
- Request pacing (`minIntervalMs`, the per-minute window, `Retry-After` and backoff delays) stays on the worker's injected clock. A `nextAllowedAt` computed by the worker is compared with the store clock, so skew shifts a retry by the size of the skew but cannot affect fencing.

**Consequences.** Skew can no longer extend or shorten a lease. Tests that want a lease to expire advance the persistence clock, not the time they pass in. A retry delay is shifted by the skew: a worker clock ahead of the database makes the job wait longer, one behind makes it wait less. The per-host minimum interval is still checked by the worker before every request, and the per-host request lock still prevents overlapping requests, so a shorter retry wait cannot break politeness limits for a single worker. Running several workers with skewed clocks against one host is not supported until pacing also moves to the store clock.
