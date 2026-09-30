# Operations runbook

How to run the crawler in production: start, watch, pause, resume, review what it stopped for, and upgrade a parser safely. It assumes the Render deployment in [`DEPLOYMENT.md`](DEPLOYMENT.md) and needs no knowledge of the code. Where a step needs a decision, the runbook says so.

Every command below runs in the crawl host's shell (the Render service shell), which already has `PERSISTENCE=postgres`, the `PG*` values, `RAW_STORE_ROOT` and `USER_AGENT`. The `:personal` variants load the checked-in private-use authorization and data contract (`config/personal-use.*.json`).

## Commands at a glance

| Command | Does | Makes requests? |
| --- | --- | --- |
| `npm run start:worker:personal` | crawls until no runnable work remains, then exits | yes |
| `npm run start:operator:personal` | serves the PIN-protected phone page that starts, checks and stops a crawl ([Operator trigger](DEPLOYMENT.md#operator-trigger-55)) | only while a run is active |
| `npm run status` | progress by page type, request pace, projected time left, and the crawl scope | no |
| `npm run review:personal -- list` | pages stopped for review and open reconciliation issues; `show`, `hold`, `release-retry`, `release-permanent`, `accept`, `dismiss` | no |
| `npm run reprocess:personal -- ...` | re-parses stored raw pages with the configured parser versions | no |
| `npm run manifest` | the manifest dry-run report: eligible schools, linked and unavailable seasons, unique URLs, projected requests, hours and storage | no |
| `npm run reconcile` | the reconciliation report (exit 5 when it names failures) | no |
| `npm run repair:raw` | the raw-store inventory: missing or damaged objects and orphans (exit 5 when something needs repair) | no |
| `npm run robots:check -- robots.txt` | checks a saved robots.txt against the paths the crawler refuses | no |

Exit codes: `0` success, `1` unexpected failure (including an unreachable or unmigrated database), `2` invalid mode, `3` rejected configuration (the message names the variable and an example), `4` a configured parser is missing, `5` a report named failures, `6` the crawl halted on a challenge that awaits review.

## Before each bulk run

1. **robots.txt.** Save the current file and check it:

   ```sh
   curl -sA "$USER_AGENT" https://www.sports-reference.com/robots.txt -o robots.txt
   npm run robots:check -- robots.txt
   ```

   Exit `1` means robots.txt now disallows a `/cbb/` path the crawler does not refuse. Do not crawl. Add the path to `SPORTS_REFERENCE_DISALLOWED_PATHS` in `src/application/sports-reference-source-adapter.mjs` and deploy that first.
2. **Authorization and data contract.** The worker refuses to start (exit `3`) if the authorization record is not active, has expired, or does not match the data contract's version and fingerprint. The private-use record in `config/personal-use.authorization.json` has no expiry. If the data contract changes, its authorization must be updated in the same change (see `AUTHORIZATION_CONTRACT.md`).
3. **Storage.** The full backfill needs about 8 GB of raw HTML and a larger database plan than the #78 sample (see `DEPLOYMENT.md`). Check the disk has room: `df -h /var/data`.
4. **Migrations** run as the pre-deploy command (`npm run migrate`). A process refuses to start if any migration is unrecorded.

## Start a crawl

### The #78 sample

Set `CRAWL_SAMPLE={"schools":["/cbb/schools/duke/men/","/cbb/schools/le-moyne/men/"],"endingYears":[2024]}` on the service, then start the worker (resume the Background Worker, or press Start on the operator page). It makes about 75 requests in about 9 minutes. `npm run status` shows `scope: SAMPLE, not complete coverage`. When it finishes, run `npm run reconcile > reconciliation-sample.json` and keep the file.

### The manifest dry run (#44)

Before the full backfill, and after the sample, run the manifest stage. Set `CRAWL_STAGE=manifest` (and no `CRAWL_SAMPLE`), then start the worker. It fetches the school index and every eligible school's history page, about 366 requests or 40 minutes, and stops. Season pages stay queued. Then:

```sh
npm run manifest > manifest.txt
```

The report gives eligible schools against index rows, linked target seasons, unavailable seasons per school, unique URLs, and the projected remaining requests, hours at the policy pace, and raw storage. Box scores are an estimate (16.5 per season, from the captures) until the game logs are parsed. An operator reviews it before the backfill: check the storage plan against the projected size, and look for surprising unavailable seasons. Then remove `CRAWL_STAGE` for the backfill. It continues from the queued seasons; nothing is fetched twice.

### The full backfill

Remove `CRAWL_SAMPLE` and `CRAWL_STAGE`, and start the worker. If the store holds a sample, the worker records the full scope and first runs discovery again over the stored index and history pages, with no requests, to queue every eligible school and season; pages already parsed are not refetched. The run then takes 60 to 70 hours at one request every 6 to 7 seconds (about 34,000 requests; `npm run status` projects the rest).

A scope can only widen. A worker started with a narrower scope than the store holds exits `1` with `crawl scope refused`, and nothing is changed.

## Watch it

- `npm run status` every so often. The pace should sit at or below the 600-an-hour policy ceiling, and `remaining` should fall. The projected time is a lower bound while discovery is still queueing pages.
- The crawl log (stderr, one JSON object per line). A `crawl.summary` line every 100 settled jobs carries the counters. Watch:
  - `runHalts` and `challengeStops`: the crawl halted on a challenge ([Challenges](#a-challenge-403-or-captcha));
  - `operatorStops`: pages stopped for review, for example after five 429s;
  - `retryWaits` and `permanentFailures`: some are normal (a page the site links to but does not serve is retried after 15 and 30 minutes on a 404 or 410, then given up on);
  - `parseFailures`: a layout change ([Parse failures](#a-parse-failure-layout-change)).
- `npm run review:personal -- list` for anything stopped.

## Pause, stop and resume

- **Pause:** suspend the Render service, or press Stop on the operator page. The process finishes the page it is on: a request already sent completes and is saved; one not yet sent is skipped and retried later. Then it exits. Nothing else is needed, and no job is left half-done.
- **Resume:** resume the service, or press Start or resume. The worker picks up where it stopped. Any claim the old process still held expires after 30 seconds and is retried; a request that a crashed process left open is released automatically after its deadline (`JOB_LIFECYCLE.md`). Pages already parsed are never fetched again.
- **After a crash or a deploy:** the same as a resume. A page whose claim is lost three times (its worker keeps disappearing) is marked `permanently_failed`, so a crash loop cannot repeat forever.
- **A multi-day backfill** is just a sequence of runs: stop and resume as often as needed, and each resume continues from the stored state.

## Rate limiting (429)

A 429 with a valid `Retry-After` puts that page in `retry_wait` until the time the provider asked for, never sooner. The worker keeps crawling other pages at the normal pace. After five 429s for one page, or a `Retry-After` longer than 24 hours or missing, the page stops for review as `operator_stop`.

If 429s become frequent (`retryWaits` climbing in the summaries), the provider is asking us to slow down. **Pause the crawl** for several hours, or a day. On resume:

```sh
npm run review:personal -- list --state operator_stop
npm run review:personal -- release-retry <job key> --operator <you> --reason "429s stopped; resuming after a day's pause"
```

A release gives the page a fresh 429 budget.

## A challenge (403 or CAPTCHA)

A 403 or a challenge page ("Just a moment...") means the site is refusing the crawler. The stop's reason says which check matched: `status 403`, `challenge response header`, `interstitial title`, or `captcha widget (<name>)`. A CAPTCHA widget in the markup counts only on a response under 32 KiB or a non-2xx one, so an ordinary page that embeds one (a newsletter or feedback form) is parsed, not halted on; if a page fails to parse and mentions a widget, look at it before assuming a block. **The crawl halts on the first one.** That page stops as `operator_stop` with code `challenge`, the run ends without another request, and the worker exits `6` (`worker halted: a challenge response on ... awaits operator review`). The halt is durable: every later run, whether a worker restart, a resume or the operator page's Start button, makes no request until each challenge stop has been reviewed. A Render Background Worker restarts after exiting, so it keeps exiting `6`; suspend the service while you review.

1. Suspend the service. Open the page in a normal browser and check whether the site is up and whether it blocks by address.
2. Wait at least a day before trying again. Do not change the user agent, address or pace to get around it; the crawler has no bypass by design.
3. Record the decision for each stopped page:
   - `release-retry` to try again later;
   - `release-permanent` to give up on that page;
   - `hold` to keep it stopped with a note.

   Every decision records who, when and why. Reviewers must be listed in `OPERATOR_IDS`. Any of the three lets the crawl start again. A released page is tried first, and if it is challenged again, the crawl halts again.
4. Resume the service.

## Review what the crawl stopped for

```sh
npm run review:personal -- list
npm run review:personal -- show <job key | issue id>
```

`show` prints the page's URL, the parser version and its error, the stored raw snapshot (its checksum and file path under `RAW_STORE_ROOT`), the state history, earlier decisions, and the next steps as commands. The review workflow is described in full in `JOB_LIFECYCLE.md` ("Operator review").

### A parse failure (layout change)

`parse_failed` means the parser could not read the page with confidence. Usually Sports Reference changed its layout. The raw page is stored, so fixing it needs no refetch:

1. Read the stored page at the `show` output's `objectPath`, and the error.
2. Capture fresh fixtures if needed (see [Recapture fixtures](#recapture-fixtures)), write a new parser version that reads the new layout, with tests, and deploy it ([Upgrade a parser](#upgrade-a-parser-in-production)).
3. Reprocess the failed pages: `npm run reprocess:personal -- --state parse_failed`. Each one that parses becomes `parsed`, and the pages it links to are queued.
4. Start the worker again to fetch those.

### The school index yields too few schools

If the index job ends `parse_failed` with `the school index yields only N eligible schools; expected at least 300 (about 360)`, the season the crawl assumed (named in the message) is not the season the site's index lists. The usual cause is that Sports Reference added the next season before, or has not yet by, the calendar rollover on 1 November, so every active school's `To` differs by one. Nothing was queued, and nothing is wrong with the stored page. Do not lower the floor to get past it: set `CURRENT_SEASON_ENDING_YEAR` to the season the index lists (`2027` for 2026-27) on the worker, then reprocess the index (`npm run reprocess:personal -- --page-type school_index --state parse_failed`). Unset it again once the index and the calendar agree. `npm run reconcile` applies the same floor to a stored index and reports it under `eligible_school_count`. `MIN_ELIGIBLE_SCHOOLS` lowers the floor for a store that is not the real index, such as a local experiment; leave it unset for a real crawl.

### A conflicting record

An open `conflicting_page_reprocess` issue means a stored page's content changed from the accepted record (the source corrected something). `show <issue id>` lists the fields that differ. Then either:
- `accept` it, to make the new content the record; the pages it newly links to are queued;
- `dismiss` it, to keep the accepted record.

A `conflicting_game_log_fact` issue (a game log disagrees with its box score) can only be dismissed after checking which is right. Both commands need `--operator` and `--reason`.

## Upgrade a parser in production

A parser version is a code change reviewed like any other. A new version never overwrites data by accident: a re-parse of the same stored page with a different parser version replaces the record, but a changed page is held for review (`PARSER_NORMALIZATION.md`).

1. Add the new version, for example `BoxScoreParserV2` returning version `'2'`, next to the old one in `PRODUCTION_PARSERS` (`src/parsers/index.mjs`), with tests against the real captures. Merge and deploy. Keeping v1 registered allows a rollback.
2. Set `PARSER_VERSIONS={"box_score":"2"}` on the service. From now on the worker parses box scores with v2, including pages queued before.
3. Re-parse what is stored, with no requests:

   ```sh
   npm run reprocess:personal -- --page-type box_score
   ```

   The summary counts pages accepted, superseded (changed by v2), conflicts, parse failures, and parse failures fixed. Up to 20 example job keys are listed for each problem. Parse failures here leave the v1 record in place.
4. Run `npm run reconcile` and compare it with the last report.
5. **Rollback:** set `PARSER_VERSIONS` back to `{"box_score":"1"}` and run the same `reprocess` command. The v1 records supersede the v2 ones.

## Reconcile

```sh
npm run reconcile > reconciliation-$(date +%F).json
```

Exit `0` means every check passed and nothing is quarantined; `5` means the report names failures. Each failed check lists the exact records, and `quarantined` lists parse failures, rejected links and open issues. `scope` says whether the data is a sample. For the backfill (#46), keep the final report with the run's records.

## Raw store repair

`npm run repair:raw` compares every recorded fetch with the files under `RAW_STORE_ROOT`. It reports:
- `pending` objects: missing, or damaged by a checksum mismatch. The pages behind them cannot be reprocessed until refetched.
- `orphans`: files no fetch refers to. They are kept, not deleted.
- `temporary` files: left by an interrupted write.

It changes no raw file. It exits `5` if anything is pending. See `RAW_STORAGE.md`.

## Recapture fixtures

The real-page fixtures stay on the operator's machine, never in the public repository. After a layout change, capture the changed page type, politely (7 seconds apart, stopping on any challenge):

```sh
USER_AGENT="web-scraper (+you@example.com)" node scripts/capture-fixtures.mjs /cbb/boxscores/<page>.html
```

Full procedure: `fixtures/sports-reference/README.md`.

## Test a migration on a disposable database

Never point these commands at the Render database: they create and delete tables. CI runs both on every pull request against a throwaway `postgres:16`. To run them locally with Docker:

```sh
docker run --rm -d --name scraper-pg -e POSTGRES_USER=scraper -e POSTGRES_PASSWORD=scraper -e POSTGRES_DB=scraper_test -p 5432:5432 postgres:16
export PGHOST=localhost PGPORT=5432 PGUSER=scraper PGPASSWORD=scraper PGDATABASE=scraper_test
PG_SMOKE_CONFIRM=disposable npm run smoke:migrations   # applies every migration twice
PG_TEST_CONFIRM=disposable npm run test:postgres
docker stop scraper-pg
```

The two `*_CONFIRM` variables are set per command on purpose; `.env.example` does not set them, so a `.env` copied from it never satisfies the guard. The scripts also refuse, whatever the variables say, a `PGHOST` that is not local (localhost, 127.0.0.1, ::1, or a unix socket directory) and a database that already holds crawl data. `test:postgres` marks the database it runs against with a `disposable_test_marker` table, so re-running it, or `smoke:migrations`, on the same local test database works. `PG_DESTRUCTIVE_OVERRIDE=<database name>` skips both checks for a private throwaway server; never set it for a database you care about.

A migration must be repeat-safe (the smoke applies it twice), and once it has been applied anywhere it is never edited: `npm run migrate` records each file's checksum and refuses to deploy an edited one, naming it. A change is a new file with the next number. In production it runs as the pre-deploy command. A migration that rewrites existing rows needs a backup first; the free database plan has none, so export the affected tables with `pg_dump` before deploying.

## Secrets

- `PGPASSWORD`, `USER_AGENT` and `OPERATOR_PIN` are dashboard secrets and are never committed.
- Error messages name a variable, never its value, and the crawl log never contains configuration.
- If a secret appears in a log, rotate it.
