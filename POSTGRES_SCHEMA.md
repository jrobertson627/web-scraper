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
