# Web scraper foundation

## Stack decision

- **Runtime:** Node.js 20 or newer.
- **Language:** ECMAScript modules (`.mjs`) with explicit runtime contracts; no runtime framework.
- **Package convention:** one deployable application, grouped by the six internal boundaries: `fetcher`, `discovery`, `parsers`, `domain`, `persistence`, and `api`. `application` is the composition root, lifecycle shell, and ingestion orchestrator.
- **Testing:** Node's built-in `node:test` runner.
- **Production persistence seam:** PostgreSQL migration contract in `migrations/`; fixture/local mode uses deterministic in-memory adapters and never opens a network connection.
- **Raw storage seam:** immutable filesystem/object-store port; fixture mode uses an in-memory content-addressed store.

The implementation intentionally has no provider-specific parser or upstream client. Those belong to later boundary epics after authorization and a versioned data contract exist. The reusable orchestrator, fetcher, discovery, parser, normalizer, and persistence seams are exercised end-to-end by the fixture application.

## Runtime modes

```sh
npm run start:local   # deterministic fixture/local mode; exits after the fixture chain
npm run start:worker  # validates authorization/configuration; exits until a production adapter is wired
npm run start:api     # read-only fixture API on 127.0.0.1:PORT (default 3000)
npm test
```

`local` is the only mode enabled by default. `worker` validates its safety gates but does not pretend to crawl without a configured production source adapter. API reads use local projections only and never start or claim crawl work.

The fixture API completes its deterministic ingestion pass before it binds the listening socket, so readiness means the fixture projections are queryable. Runtime exit codes are stable: `1` is an unexpected startup failure, `2` is an invalid mode, `3` is rejected worker configuration, and `4` means configuration is valid but no production source adapter is installed.

## Layout

- `src/application/`: composition root, lifecycle, CLI entry point, and reusable ingestion orchestrator.
- `src/config/`: immutable configuration and authorization/publication gates.
- `src/contracts/`: source-neutral value, URL, page, provenance, and state contracts.
- `src/fetcher/`: only boundary allowed to invoke transport; owns pacing, validators, retries, and raw snapshots.
- `src/discovery/`: staged link/manifest intent generation.
- `src/parsers/`: versioned parser registry and result taxonomy.
- `src/domain/`: normalization and source-value/status semantics.
- `src/persistence/`: fixture persistence, raw stores, read projections, and migration reference.
- `src/api/`: read-only HTTP surface and publication gate.
- `AUTHORIZATION_CONTRACT.md`: provider authorization, retained-data contract, and fail-closed publication rules.
- `migrations/`: ordered PostgreSQL schema migrations.
- `test/`: behavior and smoke tests.

Source providers implement the `SourceAdapter` contract (`providerId`, `indexUrl`, `classify`, and `canonicalize`) and are selected only by the composition root. Raw stores expose immutable put/get plus inventory and checksum verification; `Persistence.repairRawObjects(scope)` retains orphaned objects for review and reports missing or mismatched bodies as pending repair rather than allowing them to become parseable.

The frozen public package entry points and dependency rules are documented in [`BOUNDARY_CONTRACTS.md`](BOUNDARY_CONTRACTS.md) and enforced by the architecture test suite.

Claim generations, active-request recovery, parent ordering, and reviewed challenge release are defined in [`JOB_LIFECYCLE.md`](JOB_LIFECYCLE.md).
