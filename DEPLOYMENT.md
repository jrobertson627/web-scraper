# Deployment topology, environment, and secrets

Day-to-day operation (starting, pausing, reviewing, parser upgrades) is in [`OPERATIONS_RUNBOOK.md`](OPERATIONS_RUNBOOK.md).

This is the production topology on Render and the rules for configuration and secrets. It follows the decisions recorded on issue #52: the scraper only fills the database, and march-madness-tracker reads PostgreSQL directly.

Nothing in this repository creates or changes Render resources by itself. `render.yaml` is a Blueprint that someone applies from the Render dashboard; until then it is documentation.

## Topology

```
                        Render (one region, private network)
  +-----------------------------------+        +------------------------------+
  | web-scraper-worker                |        | Render PostgreSQL            |
  | Background Worker                 | -----> | (existing instance)          |
  | npm run start:worker:personal     | internal|                              |
  | disk: /var/data (raw store)       |  URL   +------------------------------+
  +-----------------------------------+                     ^
                                                            | read-only role
                                            march-madness-tracker (separate repo)
```

| Component | Render service | Status |
| --- | --- | --- |
| Crawl worker | Background Worker, `web-scraper-worker` | Required. Runs for days during a backfill. |
| Durable store | The existing Render PostgreSQL instance | Required. Not declared in `render.yaml`, so applying the Blueprint cannot create or replace it. |
| Raw store | Persistent disk on the worker, mounted at `/var/data` | 1 GB for the #78 sample. The full backfill (about 8 GB) is deferred until storage is upgraded (#45). |
| Read API (`start:api`) | Not deployed | Optional, and not needed by the tracker. See [Read API](#read-api). |
| Operator trigger (#55) | Not deployed | Built; a web service that replaces the worker as crawl host. See [Operator trigger](#operator-trigger-55). |

The tracker is a consumer of the database, not of this service. The scraper's schema (`POSTGRES_SCHEMA.md`, `PARSED_DOCUMENTS.md`) is the contract between them.

### Worker

- Start command: `npm run start:worker:personal`. It loads the checked-in private-use authorization and data-contract records (`config/personal-use.*.json`, which contain no secrets) and starts the same worker path as `start:worker`.
- If a configured `pageType@version` has no production parser, an accepted configuration exits with code `4` and no crawl starts. A Background Worker that exits is restarted by Render, so suspend the service after a failed configuration check rather than letting it restart in a loop.
- Stopping: Render sends `SIGTERM` on deploys, restarts and suspends, then stops the process after its grace period. Any claim the process still held is recovered after `claimTimeoutMs` and retried by the next run (see `JOB_LIFECYCLE.md`), so an interrupted crawl resumes rather than restarts. Suspending the service is the way to pause a backfill.
- A service with a persistent disk runs as a single instance and has no zero-downtime deploys. That fits the crawler, which must run one request at a time per host anyway.
- Migrations run as the pre-deploy command, `npm run migrate`. Every migration is repeat-safe, and both runtime modes refuse to start if any file in `migrations/` is unrecorded.

### PostgreSQL

- Use the database's **internal** connection values for the worker (same region, private network, no public exposure). Keep the **external** connection string for manual, out-of-band access only, and restrict it with the database's IP allow list.
- The worker reads `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` and `PGSSLMODE`, not a URL. Copy each value from the database's internal connection details into the worker's environment. Leave `PGSSLMODE` unset for the internal host; external connections need `PGSSLMODE=require`.
- The full data set will outgrow the current instance; the #78 sample fits. Upgrade the plan before the full backfill.
- Give march-madness-tracker its own read-only role rather than the scraper's owner credentials. For example, run as the owner:

  ```sql
  CREATE ROLE tracker_readonly LOGIN PASSWORD '<set in the Render dashboard, never committed>';
  GRANT CONNECT ON DATABASE <database> TO tracker_readonly;
  GRANT USAGE ON SCHEMA public TO tracker_readonly;
  GRANT SELECT ON ALL TABLES IN SCHEMA public TO tracker_readonly;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO tracker_readonly;
  ```

### Raw store

- `RAW_STORE_ROOT=/var/data/raw` on the worker's persistent disk. Raw objects are the immutable evidence behind every parse and are needed for 304 reuse and repair (`RAW_STORAGE.md`); on ephemeral storage they would be lost on every deploy, and a later 304 would stop for operator review.
- 1 GB covers the #78 sample (about 75 requests, 15–20 MB). For the full backfill, resize the disk to at least 10 GB or move the raw store to object storage; object-store credentials would then be secrets like the database password.

## Environment variables

Set these on the worker service. "Secret" means it is entered in the Render dashboard (`sync: false` in `render.yaml`), never committed, and never logged.

| Variable | Value | Secret |
| --- | --- | --- |
| `PERSISTENCE` | `postgres` | no |
| `PGHOST`, `PGPORT`, `PGDATABASE` | the database's internal host, port and name | no, but not committed |
| `PGUSER`, `PGPASSWORD` | the database owner credentials | yes |
| `PGSSLMODE` | unset for the internal host | no |
| `PG_STATEMENT_TIMEOUT_MS` | optional; server-side statement timeout (default 30000) | no |
| `RAW_STORE_ROOT` | `/var/data/raw` | no |
| `USER_AGENT` | transparent application name and operator contact, for example `web-scraper (+you@example.com)` | yes (it carries the operator's contact address) |
| `OPERATOR_IDS` | comma-separated reviewers allowed to record operator dispositions with `npm run review`, for example `jessica`; unset means nobody may (see "Operator review" in `JOB_LIFECYCLE.md`) | no |
| `CRAWL_SAMPLE` | optional; restricts the crawl to a sample, for example `{"schools":["/cbb/schools/duke/men/","/cbb/schools/le-moyne/men/"],"endingYears":[2024]}` for #78. Remove it for the full backfill (see "Decision: crawl scope" in `REQUEST_POLICY.md`) | no |
| `CRAWL_STAGE` | optional; `manifest` fetches only the index and history pages for the #44 dry run (see `OPERATIONS_RUNBOOK.md`); unset for a full crawl | no |
| `PARSER_VERSIONS` | optional; JSON parser-version overrides, for example `{"box_score":"2"}` after a parser upgrade (see `PARSER_NORMALIZATION.md`) | no |
| `OPERATOR_PIN` | only for the operator trigger service; at least 8 characters (see [Operator trigger](#operator-trigger-55)) | yes |
| `OPERATOR_TRUSTED_PROXY_HOPS` | optional; proxies in front of the operator trigger, for the per-client PIN lockout (default 1 on Render; 0 when unproxied) | no |
| `MIN_ELIGIBLE_SCHOOLS` | optional; the fewest eligible schools a school index may yield before it fails (default 300). Leave unset for a real crawl (see `OPERATIONS_RUNBOOK.md`) | no |
| `NODE_VERSION` | `22` | no |

`PROVIDER_ID`, `PROVIDER_HOST`, `AUTHORIZATION_JSON` and `DATA_CONTRACT_JSON` are set by `start:worker:personal` from the checked-in records. If a future deployment uses `start:worker` directly, supply them as dashboard values; they are configuration, not secrets, but they are never echoed into logs either.

`HOST` and `PORT` apply only to the read API, which is not deployed.

`.env.example` lists the same names with placeholder values for local runs. A filled-in `.env` is ignored by git and must never be committed.

## Secrets and logging

Policy: **error and log messages never interpolate configuration or environment values.** A message names the variable or field that failed and the expected shape, for example `PGPORT is invalid. Expected an integer from 1 through 65535`, but never the value that was supplied. This applies to every variable, not only the obviously secret ones, because a misplaced value (a password pasted into the wrong field, a token inside a JSON document) is exactly the case a value-echoing message leaks.

- Database driver errors are reported by error code only (`database is unavailable (28P01)`), since driver messages can name the host and user. The pool's idle-client error log records only the code.
- The crawl log (`src/application/crawl-log.mjs`) carries job keys, page types, hosts, status codes, counts and timings. It never logs the request policy, user agent, authorization or data contract.
- `safeMessage()` in `src/application/cli.mjs` still redacts `key=value`-shaped secrets from anything that reaches stderr, but it is a backstop. Correctness comes from not interpolating values in the first place, and new code must not rely on the regex.
- A small set of values the process itself chose or validated may appear in startup lines: the provider id, the persistence kind (`memory` or `postgres`), and the address the API bound to.
- Tests assert that rejected values and credentials do not appear in errors (`test/postgres-runtime.test.mjs`, `test/postgres-adapter-hardening.test.mjs`).

## Read API

The read API has no authentication of its own. In private publication mode every route is open to anyone who can reach the port, so **the API stays loopback-only (`127.0.0.1`, the default) unless it gets its own authentication.** That rules out binding it to `0.0.0.0` on a Render web service or private service today; a private service is still reachable by every other service in the workspace.

The tracker does not need the API, so none is deployed. If one is wanted later, add authentication to `createApiServer` first (tracked as a follow-up to #52), then deploy it as a Render private service or behind an authenticating proxy.

## Operator trigger (#55)

`npm run start:operator:personal` serves a PIN-protected page for starting, checking and stopping a crawl from a phone. It is its own server and route group (`src/application/operator-server.mjs`); the read-only API neither serves nor imports it.

| Route | Does |
| --- | --- |
| `GET /operator` | the page: a PIN field and Start or resume, Status, and Stop buttons |
| `POST /operator/trigger` | starts a run of the production worker in this process, the same assembly `start:worker` uses |
| `POST /operator/status` | crawl progress (`npm run status`), whether a run is active here, and how the last one ended |
| `POST /operator/stop` | asks the active run to stop after its current job |

- **PIN.** `OPERATOR_PIN` is a dashboard secret (`sync: false`), at least 8 characters, never committed or logged. Use a long random value: it is the only authentication. It is compared in constant time. Wrong PINs are counted per client address: five within 15 minutes lock that address's PIN checks for 15 minutes, and nobody else's. A global limit of 30 wrong PINs from anyone within 15 minutes locks every address, which bounds guessing from many addresses; it also locks out the operator, and is the price of making a PIN unguessable over the network. The client address is the `X-Forwarded-For` entry Render's proxy appends (the last one; `OPERATOR_TRUSTED_PROXY_HOPS`, default 1, says how many proxies stand in front), never an earlier entry a client could set. Set it to `0` when nothing proxies the service. IPv6 clients count by their /64. If the operator is ever locked out, suspending the service in Render clears the counters.
- **One run at a time.** A trigger is refused (409) while this process runs one, or while any job holds a live claim (another worker, judged by the job leases themselves). It is also refused while a challenge stop awaits review, since the crawl halts on a challenge (`OPERATIONS_RUNBOOK.md`); Status shows the halt. Leases and host request locks would keep two runs from overlapping requests even so; this keeps a second run from starting.
- **Hosting.** A Render disk attaches to one service, and the raw store lives on it, so the trigger service is the crawl host. It replaces the Background Worker rather than sitting beside it. To use it, create a web service with the worker's build and pre-deploy commands, disk and environment, plus `HOST=0.0.0.0` and `OPERATOR_PIN`, with the start command `npm run start:operator:personal`. Then suspend or delete `web-scraper-worker`. Render terminates TLS, so open `https://<service>.onrender.com/operator` on the phone. `render.yaml` still declares the Background Worker; switching the Blueprint is a deliberate deployment change. On a deploy or restart (`SIGTERM`), an active run finishes its current job and stops, like the worker. Trigger it again afterwards.
- **Headers.** Every response is `Cache-Control: no-store`, with a `default-src 'none'` content security policy, `X-Frame-Options: DENY` and `Referrer-Policy: no-referrer`. Bodies are limited to 2 KiB and must be a form or JSON.

## Provisioning steps

1. PostgreSQL: use the existing instance. Note its region; the worker must be in the same region.
2. Apply `render.yaml` from the Render dashboard (New, then Blueprint). Render prompts for each `sync: false` value; enter the internal `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`, and `USER_AGENT`. Set the service's region to the database's region.
3. The first deploy runs `npm ci`, then `npm run migrate`, then starts the worker. Check the deploy log for `migrate passed` and for the worker's configuration line.
4. Check progress with the Render shell on the worker: `npm run status` (the service already has `PERSISTENCE=postgres` and the PG* values). It prints progress by page type, request pace, and projected time remaining. `npm run review:personal -- list` in the same shell lists pages stopped for review; see "Operator review" in `JOB_LIFECYCLE.md`.
5. Create the tracker's read-only role (above) and give march-madness-tracker those credentials through its own service's secrets.

## The #78 sample, then the full backfill

1. Set `CRAWL_SAMPLE={"schools":["/cbb/schools/duke/men/","/cbb/schools/le-moyne/men/"],"endingYears":[2024]}` on the worker and resume it. The run fetches the index, the two history pages, the two 2024 season pages and game logs, and the box scores those logs link to: about 75 requests, 9 minutes. It records the scope, and `npm run status` reports it as a sample.
2. When the worker has exited, run `npm run reconcile` in the worker's shell. The report's `scope` says `sample`, and the season checks cover 2024 only.
3. For the full backfill, remove `CRAWL_SAMPLE` and resume the worker. It records the full scope and runs discovery again over the stored index and history pages, with no requests, to queue every eligible school and season. Pages already parsed are not refetched. A worker started with a narrower scope than the store holds refuses to start.

## Verification

- `npm run status` on the worker shows jobs moving from `pending` to `parsed`, and the pace at or below the request-policy ceiling (600 requests an hour at the 6-second interval).
- The worker's stderr is a stream of JSON crawl-log lines with periodic `crawl.summary` lines.
- Search the service logs for the database password and user agent value; neither should appear.
- The tracker can read the #78 sample tables with the read-only role and cannot write to them.
- `npm run reconcile` on the worker's shell prints the reconciliation report for what has been loaded (exit 0 when it passes, 5 when it names failures).
