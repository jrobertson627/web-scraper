# Go-live checklist

The order to take the crawler from code to a loaded database on Render. Everything that can be done before the PostgreSQL instance exists is done; what is left is provisioning, three supervised crawls (the sample, the manifest, the backfill) and the tracker's access. The crawls are real requests to Sports Reference, so each one is started by you, not by a script or an assistant.

Detail for every step is in [`DEPLOYMENT.md`](DEPLOYMENT.md) (topology, variables) and [`OPERATIONS_RUNBOOK.md`](OPERATIONS_RUNBOOK.md) (running, watching, stopping). This is the order, and what to check before moving on.

Rough clock time once provisioned: sample about 10 minutes, manifest about 40 minutes, backfill 60 to 70 hours (about 34,000 requests at one every 6 to 7 seconds), reconciliation minutes.

## 0. Before anything

- [ ] `master` is the code you mean to deploy, and its CI is green (Node 20.18.1, Node 22, PostgreSQL 16, local mode, parser evidence).
- [ ] **The season has already rolled over (1 November UTC), and this launch is for the previous seasons: 2021-22 to 2025-26, ending years 2022 to 2026.** Left to the clock, a crawl started now would run under 2027 and target 2023 to 2027. So the worker is **pinned**: `CURRENT_SEASON_ENDING_YEAR=2026` (step 2). A pinned year always wins over the clock, so it must stay set for the whole load, restarts included. Unsetting it after the index is fetched would flip the store to 2027, because the fetch date is now after the rollover. The pin only works if the site's index still lists 2025-26 schools with `To` 2026; if it already lists 2026-27 the index fails with too few eligible schools (step 6). When you later want 2026-27, unset the pin and run `refresh-season` (step 9).
- [ ] **Your local `.env` points at the old Render database**, which this launch replaces with Supabase. Replace its `PG*` values or blank them so no local command can reach the wrong database, and never put the Supabase values there either. Never run `npm run test:postgres` or `npm run smoke:migrations` with real values: they truncate tables. Use CI, or a local Docker Postgres with `PG_TEST_CONFIRM=disposable`.
- [ ] Nothing to capture for #38: Sports Reference does not record canceled or rescheduled games, so there is no such page to freeze (`fixtures/sports-reference/README.md`). A parser change needs the real-capture evidence line in its PR (`npm run parsers:verify`).

## 1. Provision PostgreSQL on Supabase

The worker and its raw-store disk stay on Render; only the database is Supabase. Nothing in this repository creates the Supabase project.

- [ ] Create the Supabase project in the region **closest to the worker's** (`render.yaml` says `oregon`, which is `us-west-2` on Supabase). Postgres 16 or later; CI tests 16. The connection crosses the public internet, so there is no "same private network" any more.
- [ ] **Size it for the backfill, not the sample.** The free plan's 500 MB will not hold the full load; check the database size projected in `manifest.txt` (step 6) against the plan before step 7 (`DEPLOYMENT.md`, "PostgreSQL").
- [ ] **Turn the Data API off before the first migration** (Integrations, Data API, then switch Enable Data API off), or at least confirm `public` is not exposed. Supabase gives `anon` and `authenticated` default privileges on `public`, and this schema has no row-level security: anyone holding the project's publishable key could read every table, including the raw-fetch and authorization records. The tracker connects over SQL as `tracker_readonly`, not through the Data API, so nothing needs it. After step 2, check the Supabase security advisor reports no "RLS disabled in public" findings that matter. Migration 020 (#158) also revokes `anon` and `authenticated` and enables row-level security, where those roles exist; switching the API off is still the first defence.
- [ ] **Connection values for the worker: use the session pooler** (Connect, Session pooler): host `aws-<n>-<region>.pooler.supabase.com` (copy it from the Connect panel; the prefix varies), port `5432`, user `postgres.<project-ref>`, database `postgres`. Not the transaction pooler (port `6543`): the migrator takes a session advisory lock and the pool relies on session settings, which transaction pooling breaks. The direct connection (`db.<ref>.supabase.co`) is IPv6 only unless the project has the paid IPv4 add-on, and Render is IPv4-only, so use the pooler.
- [ ] `PGSSLMODE=no-verify`. Supabase's certificate chain is its own CA, so `require` (which verifies) fails with a self-signed certificate error. `no-verify` is still encrypted, but does not check the server's identity.
- [ ] Set the database password in the Supabase dashboard (Database settings) and keep it out of git. Restrict the connection with network restrictions if you can.

## 2. Apply the Blueprint

The service starts as soon as it is created, and a worker with no `CRAWL_SAMPLE` starts the full backfill. `render.yaml` therefore asks for the sample when you apply it.

- [ ] Render dashboard, New, Blueprint, this repository. Enter the prompted values:
  - `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`: the Supabase session pooler values from step 1 (`PGUSER` is `postgres.<project-ref>`).
  - `PGSSLMODE`: `no-verify`. It is not in the Blueprint's prompts, so add it to the service's environment in the dashboard before the first deploy finishes.
  - `CURRENT_SEASON_ENDING_YEAR`: `2026`. Also added in the dashboard, and left set until step 9.
  - `USER_AGENT`: application name plus your contact address, for example `web-scraper (+you@example.com)`.
  - **`CRAWL_SAMPLE`: the #78 sample. Do not leave it empty.** `{"schools":["/cbb/schools/duke/men/","/cbb/schools/le-moyne/men/"],"endingYears":[2024]}`
  - `OPERATOR_IDS`: your reviewer id, for example `jessica`. Nothing can be reviewed or refreshed without it.
- [ ] Leave `MIN_ELIGIBLE_SCHOOLS` and `CRAWL_STAGE` unset.
- [ ] Before the first deploy finishes, check the worker's region is the one nearest the database and the disk is 1 GB (enough for the sample only).
- [ ] **First deploy log:** `npm ci`, then `migrate passed` (every file in `migrations/` recorded, each with a checksum), then the worker's configuration line. The worker refuses to start on a missing migration, a rejected configuration (exit 3) or a missing parser (exit 4); with `WORKER_IDLE_ON_EXIT` it then logs `worker.idle` instead of restarting in a loop.
- [ ] Raw store: the first worker records its identity (`raw_store_identity`, `.raw-store-id` on the disk). **Never point a worker on another machine at this database**; it will refuse, and a copy of the raw store without its marker is a different store.

## 3. Before each bulk run (sample, manifest, backfill)

- [ ] `curl -sA "$USER_AGENT" https://www.sports-reference.com/robots.txt -o robots.txt`, then `npm run robots:check -- robots.txt`. Exit 1 means do not crawl (`OPERATIONS_RUNBOOK.md`, "Before each bulk run"). The worker also rechecks it daily during a run.
- [ ] `df -h /var/data` on the worker's shell shows room for the run.
- [ ] `npm run status` on the worker's shell connects and shows the expected scope.

## 4. The sample (#78), about 75 requests

- [ ] The worker started with `CRAWL_SAMPLE` set, so the first run is the sample. `npm run status` says `scope: SAMPLE, not complete coverage`.
- [ ] When it finishes (`worker.idle` with `state: finished`): `npm run reconcile > reconciliation-sample.json`. It should exit 0; the report's `scope` says `sample`. Keep the file.
- [ ] `npm run review:personal -- list` is empty, or what it lists is understood.
- [ ] `npm run repair:raw` exits 0.

## 5. The tracker's access

- [ ] As the database owner (the SQL editor, or `psql` through the session pooler): `CREATE ROLE tracker_readonly LOGIN PASSWORD '<a password you set, never committed>';`. The tracker connects as `tracker_readonly.<project-ref>` through the same pooler host.
- [ ] On the worker's shell: `npm run grant:tracker -- --dry-run`, read the statements, then `npm run grant:tracker`. It gives the role the `tracker_v1` views and nothing in `public`, and refuses a role that is a superuser or can create roles or databases. Run it again whenever a new `tracker_v<n>` version ships.
- [ ] Give march-madness-tracker the role's credentials through its own service's secrets (`TRACKER_INTERFACE.md`). Its display stays behind your own authentication; it is private use, not publication (`AUTHORIZATION_CONTRACT.md`).
- [ ] From the tracker's side: the views read, `public.*` does not, nothing can be written. `crawl_scope` says the store holds a sample, and `season_completeness` says which seasons are done.

## 6. The manifest dry run (#44), about 366 requests

- [ ] Clear `CRAWL_SAMPLE` in the dashboard and set `CRAWL_STAGE=manifest`, then restart the service. It records the full scope, reads the index and every eligible school's history, and stops with the season pages queued.
- [ ] **If the index stops as `parse_failed` with "yields only N eligible schools; expected at least 300":** with the pin at 2026, the site's index already lists 2026-27 (active schools have `To` 2027). Nothing is wrong with the stored page, but the previous seasons can no longer be selected by eligibility. Stop here and decide before changing anything: pinning `2027` loads 2023 to 2027, which drops 2022 and includes the season in progress. Do not lower `MIN_ELIGIBLE_SCHOOLS` (`OPERATIONS_RUNBOOK.md`).
- [ ] `npm run manifest > manifest.txt`. Read it: eligible schools against index rows (about 360), linked and unavailable seasons per school, unique URLs, projected requests and hours, projected raw storage. Surprising unavailable seasons are worth a look before the backfill.

## 6b. Size the storage, before the backfill (#45)

Render disks only grow, so choose the size deliberately.

- [ ] **Raw store disk: at least 10 GB** (about 8 GB of raw HTML is projected; `manifest.txt` has the estimate). Change `sizeGB` in `render.yaml` and apply it, or resize in the dashboard. A larger disk is what lets the worker keep writing: it halts when free space falls under `RAW_MIN_FREE_BYTES` (default 512 MiB), so set that in proportion if you like.
- [ ] **Supabase plan** raised to fit the full load. A Supabase database that fills up goes read-only, which the worker would report as a halt.

## 7. The full backfill (#45), 60 to 70 hours

- [ ] Repeat step 3.
- [ ] Clear `CRAWL_STAGE` (and confirm `CRAWL_SAMPLE` is empty and `CURRENT_SEASON_ENDING_YEAR` is still `2026`), then restart the service. It continues from the queued seasons; nothing is fetched twice.
- [ ] **Watch it:** `npm run status` every so often (pace at or below 600 an hour, `remaining` falling), and the service logs for `crawl.summary`, `worker.idle`, `runHalts`, `challengeStops` and `operatorStops` (`OPERATIONS_RUNBOOK.md`, "Watch it"). Pausing is suspending the service; resuming continues where it stopped.
- [ ] **If it stops for a reason that is not one page** (a challenge or CAPTCHA, a 429 that needs you, robots.txt changed, the disk or database full, requests failing across pages): the worker logs `worker.idle` with `severity: error`. Read the review section of the runbook, fix the cause, release it with `npm run review:personal` (`release-halt`, `release-retry`), then restart the service. It never resumes by itself.
- [ ] The pin keeps the whole backfill on 2026. Do not unset it until the load is reconciled (step 8).

## 8. Reconcile (#46)

- [ ] When the worker is idle with `state: finished`: `npm run reconcile > reconciliation-full.json`. Exit 0 means every check passed and nothing is quarantined; exit 5 names the records.
- [ ] `npm run review:personal -- list` and work through what is left: parse failures, conflicts, stopped pages. `--state permanently_failed` lists pages that gave up; `requeue` puts one back with a fresh budget.
- [ ] `npm run repair:raw` exits 0.
- [ ] Keep both reconciliation reports with the run's records.
- [ ] Tracker check: `season_completeness` shows `complete` for the seasons you expect, and `crawl_scope` says `full`.

## 9. After go-live

- [ ] **To add 2026-27 later** (once the site lists it): unset `CURRENT_SEASON_ENDING_YEAR` on the worker (or set it to `2027`), then `npm run review:personal -- refresh-season --operator <you> --reason "..." --dry-run`, then without `--dry-run`, then start the worker (`OPERATIONS_RUNBOOK.md`, "When a new season starts"). The index was fetched after the rollover, so the refresh will report the store as already on 2027 and do nothing; it needs `--force` (use it on the dry run too). Adding a new season does not need a code change.
- [ ] A finished worker idles; restart the service to run it again. A halted one stays halted until reviewed.
- [ ] Changing the schema is a new migration, never an edit of an applied file; changing what the tracker reads is a new `tracker_v<n>` version (`POSTGRES_SCHEMA.md`, `TRACKER_INTERFACE.md`).
- [ ] A parser change needs real-capture evidence in its PR (`npm run parsers:verify`).
