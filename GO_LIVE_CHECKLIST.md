# Go-live checklist

The order to take the crawler from code to a loaded database on Render. Everything that can be done before the PostgreSQL instance exists is done; what is left is provisioning, three supervised crawls (the sample, the manifest, the backfill) and the tracker's access. The crawls are real requests to Sports Reference, so each one is started by you, not by a script or an assistant.

Detail for every step is in [`DEPLOYMENT.md`](DEPLOYMENT.md) (topology, variables) and [`OPERATIONS_RUNBOOK.md`](OPERATIONS_RUNBOOK.md) (running, watching, stopping). This is the order, and what to check before moving on.

Rough clock time once provisioned: sample about 10 minutes, manifest about 40 minutes, backfill 60 to 70 hours (about 34,000 requests at one every 6 to 7 seconds), reconciliation minutes.

## 0. Before anything

- [ ] `master` is the code you mean to deploy, and its CI is green (Node 20.18.1, Node 22, PostgreSQL 16, local mode, parser evidence).
- [ ] **Decide the date against 1 November.** The season rolls over on 1 November UTC. The crawl fixes its season when the school index is fetched, so a backfill that starts before 1 November and runs past it stays on 2026 (targets 2022 to 2026). That is fine. If the site lists 2026-27 early, or the index fails with too few eligible schools, see step 6. After the site lists the new season, `npm run review:personal -- refresh-season` brings a loaded store up to it.
- [ ] **Your local `.env` points at the old Render database.** When the new instance exists, replace its `PG*` values or blank them so no local command can reach the wrong database. Never run `npm run test:postgres` or `npm run smoke:migrations` with it: they truncate tables. Use CI, or a local Docker Postgres with `PG_TEST_CONFIRM=disposable`.
- [ ] **Optional, needs the live site:** capture a canceled or rescheduled game for the parser fixtures (#38, `OPERATIONS_RUNBOOK.md` "Recapture fixtures"). Without it the parser may quarantine those games on the real run and add to the review load. A parser change then needs the real-capture evidence line in its PR (`npm run parsers:verify`).

## 1. Provision PostgreSQL

- [ ] Create the instance in the **same region as the worker** (`render.yaml` says `oregon`; change it there if you choose another). PostgreSQL 16 is what CI tests.
- [ ] **Size it for the backfill, not the sample.** The full load needs a larger plan than the sample (`DEPLOYMENT.md`, "PostgreSQL"). Plans can be raised later; do it before step 7.
- [ ] Note the **internal** host, port, database and user for the worker. Keep the external string for manual access only, behind the IP allow list (`PGSSLMODE=require` there).

## 2. Apply the Blueprint

The service starts as soon as it is created, and a worker with no `CRAWL_SAMPLE` starts the full backfill. `render.yaml` therefore asks for the sample when you apply it.

- [ ] Render dashboard, New, Blueprint, this repository. Enter the prompted values:
  - `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`: the internal values.
  - `USER_AGENT`: application name plus your contact address, for example `web-scraper (+you@example.com)`.
  - **`CRAWL_SAMPLE`: the #78 sample. Do not leave it empty.** `{"schools":["/cbb/schools/duke/men/","/cbb/schools/le-moyne/men/"],"endingYears":[2024]}`
  - `OPERATOR_IDS`: your reviewer id, for example `jessica`. Nothing can be reviewed or refreshed without it.
- [ ] Leave `CURRENT_SEASON_ENDING_YEAR`, `MIN_ELIGIBLE_SCHOOLS` and `CRAWL_STAGE` unset.
- [ ] Before the first deploy finishes, check the region matches the database's and the disk is 1 GB (enough for the sample only).
- [ ] **First deploy log:** `npm ci`, then `migrate passed` (migrations 001 to 019 recorded, each with a checksum), then the worker's configuration line. The worker refuses to start on a missing migration, a rejected configuration (exit 3) or a missing parser (exit 4); with `WORKER_IDLE_ON_EXIT` it then logs `worker.idle` instead of restarting in a loop.
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

- [ ] As the database owner: `CREATE ROLE tracker_readonly LOGIN PASSWORD '<a password you set, never committed>';`
- [ ] On the worker's shell: `npm run grant:tracker -- --dry-run`, read the statements, then `npm run grant:tracker`. It gives the role the `tracker_v1` views and nothing in `public`, and refuses a role that is a superuser or can create roles or databases. Run it again whenever a new `tracker_v<n>` version ships.
- [ ] Give march-madness-tracker the role's credentials through its own service's secrets (`TRACKER_INTERFACE.md`). Its display stays behind your own authentication; it is private use, not publication (`AUTHORIZATION_CONTRACT.md`).
- [ ] From the tracker's side: the views read, `public.*` does not, nothing can be written. `crawl_scope` says the store holds a sample, and `season_completeness` says which seasons are done.

## 6. The manifest dry run (#44), about 366 requests

- [ ] Clear `CRAWL_SAMPLE` in the dashboard and set `CRAWL_STAGE=manifest`, then restart the service. It records the full scope, reads the index and every eligible school's history, and stops with the season pages queued.
- [ ] **If the index stops as `parse_failed` with "yields only N eligible schools; expected at least 300":** the site lists a different season from the calendar's. Set `CURRENT_SEASON_ENDING_YEAR` to the season it lists (`2027` for 2026-27), reprocess the index (`npm run reprocess:personal -- --page-type school_index --state parse_failed`), and unset it again once they agree. Do not lower `MIN_ELIGIBLE_SCHOOLS` (`OPERATIONS_RUNBOOK.md`).
- [ ] `npm run manifest > manifest.txt`. Read it: eligible schools against index rows (about 360), linked and unavailable seasons per school, unique URLs, projected requests and hours, projected raw storage. Surprising unavailable seasons are worth a look before the backfill.

## 6b. Size the storage, before the backfill (#45)

Render disks only grow, so choose the size deliberately.

- [ ] **Raw store disk: at least 10 GB** (about 8 GB of raw HTML is projected; `manifest.txt` has the estimate). Change `sizeGB` in `render.yaml` and apply it, or resize in the dashboard. A larger disk is what lets the worker keep writing: it halts when free space falls under `RAW_MIN_FREE_BYTES` (default 512 MiB), so set that in proportion if you like.
- [ ] **Database plan** raised to fit the full load.

## 7. The full backfill (#45), 60 to 70 hours

- [ ] Repeat step 3.
- [ ] Clear `CRAWL_STAGE` (and confirm `CRAWL_SAMPLE` is empty), then restart the service. It continues from the queued seasons; nothing is fetched twice.
- [ ] **Watch it:** `npm run status` every so often (pace at or below 600 an hour, `remaining` falling), and the service logs for `crawl.summary`, `worker.idle`, `runHalts`, `challengeStops` and `operatorStops` (`OPERATIONS_RUNBOOK.md`, "Watch it"). Pausing is suspending the service; resuming continues where it stopped.
- [ ] **If it stops for a reason that is not one page** (a challenge or CAPTCHA, a 429 that needs you, robots.txt changed, the disk or database full, requests failing across pages): the worker logs `worker.idle` with `severity: error`. Read the review section of the runbook, fix the cause, release it with `npm run review:personal` (`release-halt`, `release-retry`), then restart the service. It never resumes by itself.
- [ ] A backfill that runs past 1 November stays on the season it started under. When the site lists the new season, see step 9.

## 8. Reconcile (#46)

- [ ] When the worker is idle with `state: finished`: `npm run reconcile > reconciliation-full.json`. Exit 0 means every check passed and nothing is quarantined; exit 5 names the records.
- [ ] `npm run review:personal -- list` and work through what is left: parse failures, conflicts, stopped pages. `--state permanently_failed` lists pages that gave up; `requeue` puts one back with a fresh budget.
- [ ] `npm run repair:raw` exits 0.
- [ ] Keep both reconciliation reports with the run's records.
- [ ] Tracker check: `season_completeness` shows `complete` for the seasons you expect, and `crawl_scope` says `full`.

## 9. After go-live

- [ ] **When the next season starts** (from 1 November, once the site lists it): `npm run review:personal -- refresh-season --operator <you> --reason "..." --dry-run`, then without `--dry-run`, then start the worker (`OPERATIONS_RUNBOOK.md`, "When a new season starts"). Adding a new season does not need a code change.
- [ ] A finished worker idles; restart the service to run it again. A halted one stays halted until reviewed.
- [ ] Changing the schema is a new migration, never an edit of an applied file; changing what the tracker reads is a new `tracker_v<n>` version (`POSTGRES_SCHEMA.md`, `TRACKER_INTERFACE.md`).
- [ ] A parser change needs real-capture evidence in its PR (`npm run parsers:verify`).
