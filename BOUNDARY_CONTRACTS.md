# Boundary contracts

The application has six internal boundaries. Consumers import their narrow entry point through the package exports in `package.json`; fixture adapters, SQL mappings, selectors, and framework objects remain internal.

| Boundary | Public entry point | Port methods | Allowed implementation dependencies |
| --- | --- | --- | --- |
| Fetcher | `web-scraper-foundation/fetcher` | `fetch` | Node runtime, contracts |
| Discovery | `web-scraper-foundation/discovery` | `discover` | contracts |
| Parsers | `web-scraper-foundation/parsers` | `get` | contracts |
| Domain normalization | `web-scraper-foundation/domain` | `normalize` | contracts |
| Persistence | `web-scraper-foundation/persistence` | claim, transition, parse/page commit, recovery | Node runtime, contracts, pinned PostgreSQL driver |
| API/UI | `web-scraper-foundation/api` | stable school, season, game, and health reads | Node runtime, configuration gate |

Shared immutable constructors live in `web-scraper-foundation/contracts`. They define page types, jobs, snapshots, fetch/discovery/parse/normalization results, provenance, reconciliation issues, and query models. The composition root is the only module that assembles implementations and fixture adapters. It has two assemblies: `createFixtureApplication` for tests and local mode (fake time, fixture pages, in-memory persistence by default; it refuses the real `HttpTransport`), and `createWorkerApplication` for a real crawl. The worker assembly validates the configuration in worker mode, so the authorization and data-contract gate runs first, and accepts only real parts: the system clock and a sleep that waits (checked at startup), `HttpTransport`, `PostgresPersistence`, the filesystem raw store, a production parser for every page type, and a source adapter for the configured provider (`SportsReferenceSourceAdapter` by default). Parsers are injected as a `ParserRegistry`; `createProductionParserRegistry` holds the production list, which stays empty until the phase 2 parsers (#39-#42) exist, so the worker refuses to start until then.

Discovery and parsers consume snapshots and never receive transport or persistence. Domain normalization consumes parsed documents and contract values, not persistence records. API/UI receives only the four-method query port, so a handler cannot claim crawl work or call upstream transport.
