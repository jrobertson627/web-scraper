# Boundary contracts

The application has six internal boundaries. Consumers import their narrow entry point through the package exports in `package.json`; fixture adapters, SQL mappings, selectors, and framework objects remain internal.

The port methods below are the ones `assertBoundaryPort` checks (`BOUNDARY_PORT_METHODS` in `src/contracts/boundaries.mjs`); a test keeps this table in step with that list.

| Boundary | Public entry point | Port methods | Allowed implementation dependencies |
| --- | --- | --- | --- |
| Fetcher | `web-scraper-foundation/fetcher` | `fetch` | Node runtime, contracts |
| Discovery | `web-scraper-foundation/discovery` | `discover` | contracts |
| Parsers | `web-scraper-foundation/parsers` | `get`, `parse` | contracts, Cheerio (Sports Reference parsers) |
| Domain normalization | `web-scraper-foundation/domain` | `normalize` | contracts |
| Persistence | `web-scraper-foundation/persistence` | `claimNextJob`, `listJobs`, `getJob`, `transitionJob`, `recordParse`, `commitPage`, `commitPageAndTransition`, `recoverExpiredClaims`; plus the read port below | Node runtime, contracts, pinned PostgreSQL driver (loaded only for a real pool) |
| API/UI | `web-scraper-foundation/api` | `listSchools`, `listSeasons`, `listGames`, `getGame`, `health` | Node runtime, contracts, configuration gate |

Shared immutable constructors live in `web-scraper-foundation/contracts`. They define page types, jobs, snapshots, fetch/discovery/parse/normalization results, provenance, reconciliation issues, and query models. The composition root is the only module that assembles implementations and fixture adapters. It has two assemblies: `createFixtureApplication` for tests and local mode (fake time, fixture pages, in-memory persistence by default; it refuses the real `HttpTransport`), and `createWorkerApplication` for a real crawl. The worker assembly validates the configuration in worker mode, so the authorization and data-contract gate runs first, and accepts only real parts: the system clock and a sleep that waits (checked at startup), `HttpTransport`, `PostgresPersistence`, the filesystem raw store, a production parser for every page type, and a source adapter for the configured provider (`SportsReferenceSourceAdapter` by default). Parsers are injected as a `ParserRegistry`; `createProductionParserRegistry` registers the five Sports Reference parsers (#39-#42), and the worker refuses to start if a configured `pageType@version` has no production parser.

Operator review uses `BOUNDARY_PORT_METHODS.persistenceReview` (`reviewJobs`, `reviewJob`, `reviewIssues`, `getIssue`, `getJob`, `getSourceFetch`, `recordOperatorDisposition`, `acceptRevision`, `dismissIssue`), assembled by `createReviewApplication`; see "Operator review" in `JOB_LIFECYCLE.md`.

Offline reprocessing uses a third persistence port, `BOUNDARY_PORT_METHODS.persistenceReprocess` (`listJobsForReprocess`, `getJob`, `lastSuccessfulFetch`, `commitReprocess`), which both adapters implement. Its production assembly, `createReprocessApplication`, takes the same durable parts as the worker but no transport; see `PARSER_NORMALIZATION.md`.

The PostgreSQL adapter loads the `pg` driver only when it creates a real pool, so local mode and every test that injects a fake pool run without the driver installed.

Discovery and parsers consume snapshots and never receive transport or persistence. Domain normalization consumes parsed documents and contract values, not persistence records. API/UI receives only the five-method query port (`listSchools`, `listSeasons`, `listGames`, `getGame`, `health`), so a handler cannot claim crawl work or call upstream transport.

## API and persistence read interface

The query service is built on a persistence read port (`BOUNDARY_PORT_METHODS.persistenceReads`: `listSchools`, `listSeasons`, `listGames`, `getGame`, `health`) that both the PostgreSQL and in-memory adapters implement. Each API route maps to exactly one read; no route loads the whole read model.

| Route | Persistence read | Returns | PostgreSQL statement |
| --- | --- | --- | --- |
| `GET /schools` | `listSchools({ limit, cursor })` | `{ items, nextCursor }` | one keyset page on `schools (provider_id, canonical_source_path)` |
| `GET /seasons` | `listSeasons({ limit, cursor })` | `{ items, nextCursor }` | one keyset page ordered by school key, then `ending_year` |
| `GET /games` | `listGames({ limit, cursor })` | `{ items, nextCursor }` | one keyset page on `games (provider_id, canonical_box_score_path)`, with each game's latest accepted revision |
| `GET /games/:key` | `getGame(key)` | the game or `null` | one lookup on the `games` unique key |
| `GET /health` | `health()` | counts only | one statement of counts; no entity rows |

Paging:

- `limit` is an integer from 1 through 500 (default 100). `cursor` is opaque: pass back the `nextCursor` of the previous page. `createPageRequest` validates both, and an invalid value is a 400 with `invalid_paging`.
- Paging is keyset, not offset: each adapter encodes the sort key of the last row it returned and resumes strictly after it, so a deep page costs the same as the first. A cursor is only meaningful to the adapter that issued it.
- The HTTP list bodies stay plain JSON arrays. When another page exists, the response carries `Link: </games?limit=100&cursor=...>; rel="next"` and `X-Next-Cursor`.
- A game key is `<providerId>:<canonical box-score path>`. Because a host may carry a port, the PostgreSQL adapter tries every `:` split in one lookup against the unique key.

`health` counts job states, fetches, parse runs and warnings, unavailable coverage, open reconciliation issues, and accepted observations. It is bounded in statements and memory, but exact counts still scan their tables; if that becomes slow on the full backfill, switch the large counts to estimates rather than loading rows.

`queryModels()` remains on the in-memory adapter for fixture tests; the PostgreSQL adapter no longer implements it. The reconciliation report reads its own port, `BOUNDARY_PORT_METHODS.persistenceReconciliation`, which both adapters implement (see `FOUNDATION_HANDOFF.md`).
