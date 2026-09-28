# Web scraper foundation

## Stack decision

- **Runtime:** Node.js 20 or newer.
- **Language:** ECMAScript modules (`.mjs`) with explicit runtime contracts; no runtime framework.
- **Package convention:** one deployable application, grouped by the six internal boundaries: `fetcher`, `discovery`, `parsers`, `domain`, `persistence`, and `api`. `application` is the composition root, lifecycle shell, and ingestion orchestrator.
- **Testing:** Node's built-in `node:test` runner.
- **Production persistence:** ordered PostgreSQL migrations and a durable adapter behind the persistence port; fixture/local mode retains deterministic in-memory adapters and never opens a network connection.
- **Raw storage seam:** immutable filesystem/object-store port; fixture mode uses an in-memory content-addressed store.

The implementation has a source-neutral HTTPS transport, the production Sports Reference source adapter, real-page discovery, versioned v1 parsers for all five Sports Reference page types, and a production worker assembly (`createWorkerApplication`). The reusable orchestrator, fetcher, discovery, parser, normalizer, and persistence seams are exercised end-to-end by the fixture application; local TLS integration tests exercise the real transport without contacting an upstream provider.

## Runtime modes

```sh
npm run start:local   # deterministic fixture/local mode; exits after the fixture chain
npm run start:worker  # validates authorization/configuration, then crawls with PERSISTENCE=postgres
npm run start:worker:personal  # loads the private, self-attested M1 records; set USER_AGENT and RAW_STORE_ROOT first
npm run reprocess -- --page-type box_score   # re-parse stored raw snapshots with PARSER_VERSIONS; no requests
npm run start:api     # read-only fixture API on HOST:PORT (default 127.0.0.1:3000)
npm run status        # crawl progress by page type, request pace, projected time remaining (--json for JSON)
npm test
npm run test:postgres    # real, explicitly disposable PostgreSQL database
npm run smoke:migrations # applies all migrations twice to a disposable database
```

`local` is the only mode enabled by default. `worker` validates its safety gates before it builds anything, and refuses to crawl without PostgreSQL or with a missing production parser. API reads use local projections only and never start or claim crawl work.

Milestone 1 includes a private, single-operator configuration in `config/personal-use.*.json`. Set a transparent contact-bearing `USER_AGENT` and an absolute `RAW_STORE_ROOT`, then run `npm run start:worker:personal`. This record is an operator attestation, not evidence of a provider grant; it never enables public publication. See [`AUTHORIZATION_CONTRACT.md`](AUTHORIZATION_CONTRACT.md) for its retained fields, attribution, and source-link convention.

Start with an empty disposable PostgreSQL database and explicit `PGHOST`, `PGDATABASE`, and `PGUSER`. Run `smoke:migrations` first with `PG_SMOKE_CONFIRM=disposable` and `psql` on `PATH`; then run `test:postgres` with `PG_TEST_CONFIRM=disposable`. The PostgreSQL adapter can be injected into the fixture composition with a filesystem raw store for offline integration and restart tests. These tests make no external source requests.

CI (`.github/workflows/ci.yml`) runs on every push to `master` and every pull request. It runs `npm run check` and `smoke:foundation` on Node 20.18.1 and 22, then runs local mode and the unit suite with the `pg` driver removed, and runs `smoke:migrations`, `migrate` and `test:postgres` against a throwaway `postgres:16` service container. The real Sports Reference captures are not in the repository, so their tests skip in CI.

The fixture API completes its deterministic ingestion pass before it binds the listening socket, so readiness means the fixture projections are queryable. Runtime exit codes are stable: `1` is an unexpected startup failure (including an unreachable or unmigrated database), `2` is an invalid mode, `3` is rejected configuration, and `4` means configuration is valid but the worker cannot crawl (a configured `pageType@version` has no production parser).

### Durable persistence

`api` and `worker` use PostgreSQL only when `PERSISTENCE=postgres`; otherwise they stay in memory, and `local` always does. Connection values come from `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`, and `PGSSLMODE` (`require` for external hosts). At startup both modes confirm that every file in `migrations/` is recorded in `schema_migrations` and refuse to start otherwise. With Postgres, `api` serves the durable projections read-only and runs no fixture ingestion. `worker` requires `PERSISTENCE=postgres` for a real crawl. It opens the database with the policy's request timeout, exits `4` and names the missing parsers while any production parser is missing, and otherwise builds `createWorkerApplication`, queues the school index, and runs until no runnable work remains or SIGTERM/SIGINT stops it. Structured crawl-log lines go to stderr, and `WORKER_ID` names the lease owner (default `worker`).

The API binds `127.0.0.1` unless `HOST` names another IP address (or `localhost`). The API has no authentication of its own, so it stays loopback-only unless it gets its own; the production topology, environment, and secrets rules are in [`DEPLOYMENT.md`](DEPLOYMENT.md).

### Crawl logs and status

The fetcher and orchestrator report crawl operations to an injected `events` sink, passed through the composition root; parsers, discovery, and domain normalization never receive it. `createCrawlLog` (`src/application/crawl-log.mjs`) writes one JSON object per line to stderr and keeps counters:

| Event | Emitted by | Counters |
| --- | --- | --- |
| `request.started` | fetcher, per upstream request | `requestsStarted` |
| `cache.hit`, `cache.not_modified` | fetcher, fresh-cache reuse and 304 | `cacheHits`, `notModified` |
| `throttle.paused` | fetcher, each pacing sleep | `throttlePauses`, `throttleWaitMs` |
| `page.discovered` | orchestrator, after discovery | `discoveredChildren`, `duplicateDiscoveries` |
| `job.settled` | orchestrator, one per processed job | `parsed`, `retryWaits`, `operatorStops`, `challengeStops`, `permanentFailures`, `parseFailures`, `parseWarnings`, `mergeConflicts` |
| `reconciliation.completed` | composition root, `reconcile()` | `reconciliationFailures` |
| `crawl.summary` | every 100 settled jobs and at the end of a run | all counters, settled jobs by page type, and job-state counts |

Duplicate discovery is counted within one process; persistence still deduplicates jobs durably. Log lines carry job keys, page types, hosts, codes, counts, and timings, never configuration or environment values. `start:local` writes this log to stderr.

`npm run status` reads the configured store (PostgreSQL with `PERSISTENCE=postgres`; otherwise it runs the fixture crawl) and prints job progress by page type, network requests in the last hour, the observed pace against the request-policy ceiling, and the projected time remaining for the jobs already discovered. While discovery is still queueing pages, that projection is a lower bound.

## Layout

- `src/application/`: composition root, lifecycle, CLI entry point, and reusable ingestion orchestrator.
- `src/config/`: immutable configuration and authorization/publication gates.
- `src/contracts/`: source-neutral value, URL, page, provenance, and state contracts.
- `src/fetcher/`: only boundary allowed to invoke transport; owns pacing, validators, retries, and raw snapshots. The real HTTPS transport enforces DNS and body limits while the fixture transport keeps local runs deterministic.
- `src/discovery/`: staged link/manifest intent generation.
- `src/parsers/`: versioned parser registry and result taxonomy.
- `src/domain/`: normalization and source-value/status semantics.
- `src/persistence/`: fixture and PostgreSQL persistence, raw stores, and read projections.
- `src/api/`: read-only HTTP surface and publication gate.
- `AUTHORIZATION_CONTRACT.md`: provider authorization, retained-data contract, and fail-closed publication rules.
- `URL_IDENTITY.md`: provider-scoped URL identity, canonicalization, and host allowlisting rules.
- `RAW_STORAGE.md`: immutable raw objects, durable finalization, and repair protocol.
- `POSTGRES_SCHEMA.md`: migration ordering, durable constraints, provenance, and compatibility rules.
- `PARSER_NORMALIZATION.md`: versioned parsing, value states, provenance, conflict quarantine, and offline reprocessing after a parser upgrade.
- `REQUEST_POLICY.md`: validated runtime scope, pacing, cache, timeout, and retry rules.
- `COMPOSITION_READ_BOUNDARY.md`: atomic fixture page commits, worker progress, dry-run preview, and read isolation.
- `FOUNDATION_HANDOFF.md`: fixture matrix, reconciliation, transition/value glossary, package ownership, and live PostgreSQL evidence.
- `migrations/`: ordered PostgreSQL schema migrations.
- `test/`: behavior and smoke tests.

Source providers implement the `SourceAdapter` contract (`providerId`, `indexUrl`, `classify`, and `canonicalize`) and are selected only by the composition root. Raw stores expose immutable put/get plus inventory and checksum verification; `Persistence.repairRawObjects(scope)` retains orphaned objects for review and reports missing or mismatched bodies as pending repair rather than allowing them to become parseable.

The filesystem raw store requires an explicit absolute root (`RAW_STORE_ROOT` for worker configuration). Its repair report returns counts, checksums, object paths, and affected fetch IDs; it retains orphaned and interrupted temporary files for operator review. See [`RAW_STORAGE.md`](RAW_STORAGE.md).

The frozen public package entry points and dependency rules are documented in [`BOUNDARY_CONTRACTS.md`](BOUNDARY_CONTRACTS.md) and enforced by the architecture test suite.

Claim generations, active-request recovery, parent ordering, and reviewed challenge release are defined in [`JOB_LIFECYCLE.md`](JOB_LIFECYCLE.md).
