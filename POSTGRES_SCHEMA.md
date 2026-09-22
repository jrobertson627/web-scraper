# PostgreSQL schema and migration contract

Migrations are ordered `001_foundation` through `004_schema_hardening` and record their versions in `schema_migrations`. Every create, alter, and index operation is repeat-safe. The schema is provider-scoped for canonical jobs, games, linked identities, observations, authorization, and publication policy.

The schema preserves the ingestion lifecycle: claims and lease generations are fenced, state events are durable, active host requests are unique, successful fetches require a checksum/object-path reference (including 304 reuse), and raw repair records retain pending/orphan reasons and source-fetch references.

Normalized entities require provenance. School-season and unavailable-coverage rows receive an explicit empty provenance object when upgrading older data, then enforce non-null provenance for new writes. Parser status, job state, publication redistribution, checksum format, and request release/outcome relationships are constrained at the database boundary.

Page effects should be written in one transaction with the final job transition. Read consumers use stable projections rather than raw PostgreSQL rows; migration tests validate the schema contract without requiring a live database in the fixture environment.
