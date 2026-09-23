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

Shared immutable constructors live in `web-scraper-foundation/contracts`. They define page types, jobs, snapshots, fetch/discovery/parse/normalization results, provenance, reconciliation issues, and query models. The composition root is the only module that assembles implementations and fixture adapters.

Discovery and parsers consume snapshots and never receive transport or persistence. Domain normalization consumes parsed documents and contract values, not persistence records. API/UI receives only the four-method query port, so a handler cannot claim crawl work or call upstream transport.
