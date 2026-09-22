# Composition and read boundary

The composition root creates the source adapter, fixture transport, validated policy, raw store, persistence, parser registry, discovery, normalization, worker orchestrator, and query service. The worker receives the processing ports. The HTTP server receives only the query service and publication configuration; the CLI binds it to `127.0.0.1`.

After a verified fetch, parsing and normalization build a page result. `commitPageAndTransition` stages the page, observations, coverage, child jobs, reconciliation issues, and final `parsed` transition before installing any of them. Validation or transition failure leaves the previous page and job state intact. A future PostgreSQL persistence adapter must provide the same operation within one database transaction.

The worker returns typed events for parsed pages, retries, operator stops, permanent failures, and parse failures. Events carry job identity, warnings, reasons, and reconciliation counts. Query services expose stable school, season, game, game-detail, and health models without crawl methods. Local reads continue after the worker stops and never invoke transport.

`previewDryRun()` follows fixture links without transport or persistence writes. It reports unique pre-backfill URLs, distinct box-score links, unavailable target coverage, page-type counts, and a minimum runtime estimate based on the configured request interval. PostgreSQL migration execution awaits the planned database instance.
