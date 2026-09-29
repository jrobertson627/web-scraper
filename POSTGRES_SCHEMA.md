# PostgreSQL schema and migration contract

Migrations are ordered from `001_foundation` and each records its version in `schema_migrations`. Every create, alter, and index operation is repeat-safe. The schema is provider-scoped for canonical jobs, games, linked identities, observations, authorization, and publication policy.

`source_fetches.cache_control` retains the upstream cache directive. `cache_hit` distinguishes a fresh-cache reuse from a network 200; a cache hit must also set `reused_body`. A 304 records a new fetch referencing the existing verified immutable object.

The schema preserves the ingestion lifecycle: claims and lease generations are fenced, state events are durable, active host requests are unique, successful fetches require a checksum/object-path reference (including 304 reuse), and raw repair records retain pending/orphan reasons and source-fetch references.

Normalized entities require provenance. School-season and unavailable-coverage rows receive an explicit empty provenance object when upgrading older data, then enforce non-null provenance for new writes. Parser status, job state, publication redistribution, checksum format, and request release/outcome relationships are constrained at the database boundary.

Page effects should be written in one transaction with the final job transition. Read consumers use stable projections rather than raw PostgreSQL rows; migration tests validate the schema contract without requiring a live database in the fixture environment.

`007_postgres_repositories` adds a monotonic `claim_generation` counter separate from the active lease columns, because the active lease is cleared on retry and terminal transitions. It also retains every observation revision and prevents multiple active requests for one job. The PostgreSQL integration suite runs against a disposable real database with `PG_TEST_CONFIRM=disposable`.

`010_reconciliation_issue_dedup` adds `reconciliation_issues.dedup_key` and makes open issues unique on `(issue_type, record_key, dedup_key)` instead of `md5(details)`. Details carry provenance such as the source fetch id, so the old index opened a new issue on every refetch of an unchanged conflicting page. A `conflicting_page_reprocess` key is the accepted revision id plus a hash of the conflicting content; a `conflicting_game_log_fact` key is the school, field, observed value and canonical value. Rows from before the migration keep their old identity as `legacy:<md5>`.

The adapter's pool logs an idle client's `'error'` (by error code only) instead of crashing the process, sets a server-side `statement_timeout` (30 s by default, `PG_STATEMENT_TIMEOUT_MS` to tune), and destroys a client whose `ROLLBACK` failed rather than returning it to the pool.

`011_claim_check_consolidation` replaces the two overlapping claim constraints, 001's unnamed CHECK and 004's `crawl_jobs_claim_state_check`, with one `crawl_jobs_claim_state_check`: a `fetching` or `fetched` job holds all three claim columns (`claim_owner`, `claim_expires_at`, `lease_generation`), and a job in any other state holds none. That is exactly what the two constraints enforced together.

`012_review_dispositions` adds `reconciliation_dispositions`, the record of each operator `accept` or `dismiss` of a reconciliation issue: who, when, why, and for an accept the `normalized_page_revisions` row that became accepted. It also adds `reconciliation_issues.opened_at`, which older rows take from the time the migration ran. An accepted issue has status `accepted` and a dismissed one `resolved`. Stop releases stay in `operator_dispositions`.

`013_crawl_scopes` records the scope each crawl ran under (#78): `kind` is `sample` or `full`, and a sample also has `schools` (site paths) and `ending_years`. The latest row is the store's current scope; a store with none was crawled under the full scope. Readers such as march-madness-tracker should check it before treating the data as complete.

## Migration rules

`npm run migrate` (`scripts/migrate.mjs`, logic in `src/persistence/migrator.mjs`) is how every database, including production, is brought up to date, and the database is added to over time, so the files are append-only history (#120).

- **Skip what is applied.** Only files whose version is not in `schema_migrations` run. A database that is up to date executes no DDL.
- **Never edit an applied file.** `schema_migrations.checksum` holds the SHA-256 of each file as it was applied (line endings and a byte-order mark ignored). If an applied file's content differs, the run fails before applying anything and names it. Put the change in a new file with the next number.
- **Number in order.** A new file that sorts before an applied one is refused.
- **Each file is repeat-safe and records itself.** It carries its own `BEGIN`/`COMMIT`, uses `IF NOT EXISTS` and similar guards, and inserts its own version into `schema_migrations`. `npm run smoke:migrations` applies every file twice to prove it. A run that stopped after a file committed but before its checksum was recorded adopts the file on the next run instead of running it again.
- **Additive by default.** Adding a table, column or index is one migration. Removing or renaming a column that a reader may use (march-madness-tracker reads this database) is expand-then-contract: add the new shape, move readers, and only then drop the old one in a later migration. 008 dropped a column in one step; do not repeat that.
- **Locks.** The run holds an advisory lock, and sets `lock_timeout` (5 s) and `statement_timeout` (120 s); a migration that must hold a lock or run longer says so in its pull request and raises `MIGRATE_STATEMENT_TIMEOUT_MS` for that deploy.
- **An older checkout is not an error.** Versions recorded in the database with no file here are reported and ignored, so code can be rolled back over a newer schema.
