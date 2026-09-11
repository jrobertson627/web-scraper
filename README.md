# Web scraper foundation

## Stack decision

- **Runtime:** Node.js 20 or newer.
- **Language:** ECMAScript modules (`.mjs`) with JSDoc types where useful; no runtime framework.
- **Package convention:** one deployable application, grouped by the six internal boundaries: `fetcher`, `discovery`, `parsers`, `domain`, `persistence`, and `api`. `application` is the composition root and lifecycle shell, not a domain boundary.
- **Testing:** Node's built-in `node:test` runner.
- **Production persistence seam:** PostgreSQL migration contract in `migrations/`; fixture/local mode uses deterministic in-memory adapters and never opens a network connection.
- **Raw storage seam:** immutable filesystem/object-store port; fixture mode uses an in-memory content-addressed store.

The implementation intentionally has no provider-specific parser, upstream client, or bulk-crawl command. Those belong to later boundary epics after authorization and a versioned data contract exist.

## Runtime modes

```sh
npm run start:local   # deterministic fixture/local mode; exits after the fixture chain
npm run start:worker  # worker mode; requires explicit authorization/configuration
npm run start:api     # read-only API mode on PORT (default 3000)
npm test
```

`local` is the only mode enabled by default. `worker` and public API publication fail closed unless their policy prerequisites are configured. API reads use local projections only and never start or claim crawl work.

## Layout

- `src/application/`: composition root, lifecycle, and CLI entry point.
- `src/config/`: immutable configuration and authorization/publication gates.
- `src/contracts/`: source-neutral value, URL, page, provenance, and state contracts.
- `src/fetcher/`: only boundary allowed to invoke transport.
- `src/discovery/`: staged link/manifest intent generation.
- `src/parsers/`: versioned parser registry and result taxonomy.
- `src/domain/`: normalization and source-value/status semantics.
- `src/persistence/`: fixture persistence, raw store, read projections, and migration reference.
- `src/api/`: read-only HTTP surface and publication gate.
- `migrations/`: ordered PostgreSQL schema migrations.
- `test/`: behavior and smoke tests.
