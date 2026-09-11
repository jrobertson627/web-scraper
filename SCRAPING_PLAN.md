# College Basketball Data Intake Plan

## Scope

Build a source-agnostic, sequential, resumable data-ingestion pipeline for men's college basketball data.

The school population is the men's schools table at:

- <https://www.sports-reference.com/cbb/schools/#all_NCAAM_schools>

A school is eligible when its index row has `To == 2026`.

For every eligible school, ingest only these five seasons:

| Season | Ending year used in URLs |
| --- | ---: |
| 2025–26 | `2026` |
| 2024–25 | `2025` |
| 2023–24 | `2024` |
| 2022–23 | `2023` |
| 2021–22 | `2022` |

The season filter is therefore:

```text
ending_year IN (2022, 2023, 2024, 2025, 2026)
```

A school that joined Division I during this window may have fewer than five linked seasons. Record an absent season as unavailable; do not treat it as a crawl failure or manufacture a URL for it.

## Permission and source policy gate

Obtain written permission from Sports Reference before beginning a bulk crawl or building an application around the collected data.

Sports Reference's current Data Use policy says users should not create websites or tools based on scraped Sports Reference data without permission. Its Terms of Use also restrict databases or services that materially substitute for its products. The published request limit is an operational ceiling, not permission to reproduce the dataset.

Review these sources before each bulk run:

- <https://www.sports-reference.com/robots.txt>
- <https://www.sports-reference.com/bot-traffic.html>
- <https://www.sports-reference.com/data_use.html>
- <https://www.sports-reference.com/termsofuse.html>

If permission is unavailable, preserve the architecture below but replace the Sports Reference source adapter with a data provider whose license permits the intended application.

## Architecture

Use one deployable application initially, with these internal boundaries:

1. **Fetcher** — HTTP requests, global throttling, caching, retries, and raw-response storage.
2. **Discovery** — Extracts school, season, game-log, and box-score links.
3. **Parsers** — One versioned parser per page type.
4. **Domain normalization** — Resolves schools, aliases, seasons, games, teams, and players.
5. **Persistence** — PostgreSQL for crawl state and normalized data; filesystem or object storage for raw HTML.
6. **API/UI** — Reads only the local database. User activity must never trigger upstream scraping.

Do not introduce microservices or a message broker initially. A single worker and database-backed crawl manifest provide sufficient durability and simpler rate enforcement.

```text
Sports Reference or licensed source
              |
              v
  Sequential fetcher + URL manifest
              |
              +----> Immutable raw HTML snapshots
              |
              v
       Versioned page parsers
              |
              v
         PostgreSQL
              |
              v
          API / Web UI
```

## Intake sequence

### 1. Discover eligible schools

Fetch:

```text
https://www.sports-reference.com/cbb/schools/
```

The `#all_NCAAM_schools` fragment is a browser-side anchor and is not sent to the server. Parse the men's schools table and retain rows where `To == 2026`.

Store the source school path, display name, city/state, `From`, `To`, aggregate fields, eligibility decision, source URL, and fetch timestamp.

### 2. Discover target seasons

For each eligible school, fetch its men's history page:

```text
/cbb/schools/{school-slug}/men/
```

Extract actual linked season rows and retain only ending years `2022` through `2026`, inclusive. Do not infer seasons from the numeric `From`/`To` range because Division I coverage can contain gaps and unlinked non-major seasons.

### 3. Ingest season pages

For each retained season link, fetch:

```text
/cbb/schools/{school-slug}/men/{ending-year}.html
```

Parse the agreed data contract, including:

- Team record, conference, coach, SRS, SOS, and ratings.
- Roster and player source links.
- Team aggregate statistics.
- Other explicitly selected season tables.

Store the raw page before parsing so later parser versions can backfill newly required fields without another upstream request.

### 4. Ingest game logs

Follow the actual game-log link when available:

```text
/cbb/schools/{school-slug}/men/{ending-year}-gamelogs.html
```

Store every row, including incomplete rows, with:

- Date.
- Opponent and opponent source path when linked.
- Home, away, or neutral designation.
- Game type.
- Result and overtime status.
- Team and opponent scores and totals.
- Box-score URL when present.

Missing values must remain null rather than becoming zero.

### 5. Deduplicate box scores

Queue each extracted box-score URL under a unique constraint on its canonical path. Never construct a box-score URL from a date or team name; follow the published link.

The same Division I game normally appears in both teams' game logs. It must produce one game record, two team-game records, and the associated team and player statistics.

### 6. Ingest box scores

For each unique box score, capture available data such as:

- Date, venue, attendance, and game status.
- Competing teams and final score.
- Line score and periods.
- Basic and advanced team totals.
- Basic and advanced player statistics.
- Starter or reserve designation.
- Source player links.

Allow nullable source identities because non-Division-I opponents and some players may appear without links.

## Data model

### Crawl and provenance

- `crawl_jobs`: URL, page type, parent URL, status, attempts, next allowed time, and last error.
- `source_fetches`: URL, HTTP status, fetch time, ETag, Last-Modified, checksum, and raw-object path.
- `parse_runs`: parser name/version, source fetch, status, and warnings.

### Basketball domain

- `schools`
- `school_aliases`
- `school_seasons`
- `season_rosters`
- `players`
- `games`
- `game_teams`
- `team_game_stats`
- `player_game_basic_stats`
- `player_game_advanced_stats`

Every normalized record should retain its source URL, source-fetch identifier, parsed timestamp, and parser version. Use canonical source paths as external identifiers rather than display names because school names and historical slugs can differ.

## Responsible request policy

Configure the Sports Reference fetcher to be deliberately more conservative than the published ceiling:

- One global worker for `sports-reference.com`.
- At least six seconds between request starts, limiting the crawler to at most 10 requests per minute.
- No concurrent requests to the host.
- A transparent `User-Agent` containing the application name and contact address.
- GET requests only.
- Cache every successful response.
- Use conditional requests when ETag or Last-Modified is available.
- Do not refetch an unchanged historical page unnecessarily.
- On `429`, honor `Retry-After`; if absent, suspend rather than retry aggressively.
- On `403`, CAPTCHA, or another challenge, stop and require operator review.
- Never rotate IP addresses, proxies, or user agents to bypass restrictions.
- On transient network errors or `5xx` responses, use bounded exponential backoff.

At 10 requests per minute, estimated network time is:

```text
hours ≈ unique URLs / 600
```

Build the URL manifest and calculate the unique URL count before starting the box-score backfill.

## Resumability

Each URL moves through durable states:

```text
pending -> fetching -> fetched -> parsed
              |          |
              |          +-> parse_failed
              +-> retry_wait / permanently_failed
```

Required properties:

- Re-running the importer is idempotent.
- A crash resumes from the manifest instead of restarting.
- Duplicate box-score discovery is harmless.
- Raw HTML is committed before parsing.
- Database writes for one page are transactional.
- Historical pages are not routinely refetched after successful reconciliation.
- Parser upgrades reprocess stored raw HTML offline.

## Validation

Produce reconciliation reports covering these invariants:

- Eligible-school count equals index rows with `To == 2026`.
- No accepted season has an ending year outside `2022`–`2026`.
- Discovered season count equals the linked target-season rows for each school.
- Every completed game-log row with a box-score link resolves to one game.
- One canonical box-score URL creates only one game.
- A game discovered from both team logs merges correctly.
- The recorded winner agrees with the final scores.
- Box-score team totals agree with game-log totals.
- Blank, unavailable, null, and zero remain distinct.
- Canceled, rescheduled, neutral-site, and overtime games remain representable.
- HTML layout changes quarantine affected pages rather than silently shifting columns.

Maintain representative raw-HTML fixtures for home, away, neutral, overtime, unlinked-opponent, incomplete-game, and partial historical-coverage cases.

## Delivery phases

1. **Permission and data contract**
   - Obtain authorization.
   - Enumerate the exact season and box-score fields to retain.
   - Define attribution, redistribution, and retention requirements.

2. **Vertical slice**
   - Implement index → school → target season → game log → deduplicated box score for a small representative set.

3. **Raw storage and parser fixtures**
   - Persist representative pages and implement versioned parsers plus reconciliation checks.

4. **Manifest dry run**
   - Discover eligible schools and linked seasons, then report unique URLs, unavailable seasons, and projected runtime.

5. **Historical backfill**
   - Run the single sequential worker and monitor rate-limit responses, parser failures, and reconciliation anomalies.

6. **Application layer**
   - Add the API and UI over PostgreSQL only after the backfill is reconciled.
   - Include attribution and source links as required by the granted permission or data license.
