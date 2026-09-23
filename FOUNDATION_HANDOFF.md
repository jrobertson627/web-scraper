# Foundation validation and handoff

This is the provider-neutral foundation handoff for issue #6. It proves behavior with synthetic fixtures, not permission to scrape a real source. The seven-snapshot default `npm run start:local` command is a quick readiness smoke; `fixtures/foundation-corpus.mjs` is the broader raw-HTML fixture chain used by `test/issue-6.test.mjs`.

## Runbook and current evidence

```sh
npm run start:local       # reports "fixture local ready", ingests, and exits
npm run start:api         # ingests fixture data, then reports HTTP readiness
npm run smoke:foundation   # expanded HTML chain and reconciliation JSON
npm run check             # syntax and unit/integration/smoke tests
```

The expanded fixture chain has index, two school histories, three target-season pages, three game logs, and six canonical box scores. Two team logs link to the same box score; the worker fetches that URL once. A fault variant (`node scripts/foundation-smoke.mjs --faults`) adds an off-host link and a shifted layout, and the reconciliation output names the rejected observation and failed box-score job; it exits nonzero by design. Both variants use synthetic HTML with a `fixture-document` JSON script, so they test raw-body handling without claiming provider-specific selectors. All fixture transport URLs are local to the in-memory fixture map; no real upstream request occurs.

The tests are grouped by behavior: unit contracts/parsing (`foundation`, `issue-7`, `issue-9`), integration page/manifest/reconciliation behavior (`job-lifecycle`, `issue-6`, `issue-8`), and command/API smoke (`issue-6`, `issue-13`). Tests exercise successful and rejected states. `src/application/reconciliation.mjs` checks the eleven invariants at `SCRAPING_PLAN.md:227-243`, plus partial historical coverage. Each failed check returns record keys and observations; `quarantined` lists structural failures, rejected URLs, and conflicting records.

## State transitions

| State | Allowed next states | Meaning |
| --- | --- | --- |
| `pending` | `fetching` | A parent-complete manifest job is available. |
| `fetching` | `fetched`, `retry_wait`, `permanently_failed`, `parse_failed`, `operator_stop` | A lease owns the request; retry/challenge/failure classification is explicit. |
| `fetched` | `parsed`, `parse_failed`, `retry_wait`, `operator_stop` | Immutable raw bytes and fetch metadata exist before parse/commit. |
| `retry_wait` | `fetching`, `permanently_failed` | Retry is time- and attempt-bounded. |
| `operator_stop` | `retry_wait`, `permanently_failed` | Only an authorized, recorded disposition releases it. |
| `parsed` | none | Page effects and final transition committed together. |
| `parse_failed` | none | Structural/normalization failure is quarantined. |
| `permanently_failed` | none | Terminal fetch failure. |

An expired `fetching`/`fetched` lease returns to `retry_wait` only after active request ownership is cleared. Parent jobs must be `parsed` before children are claimable. See `JOB_LIFECYCLE.md` for generation tokens and recovery details.

## Provenance and value glossary

| Term | Meaning |
| --- | --- |
| Canonical path | Provider-scoped host/path/normalized-query identity, independent of display names. |
| Source fetch | HTTP status, raw checksum/object path, cache validators, and fetch time for one attempt. |
| Parse run | Page type, parser name/version, source fetch, warnings or structural failure. |
| Provenance | Provider, source URL/canonical path, fetch ID, parser name/version, and parse time attached to accepted data. |
| Observation | A source row or rejected link retained separately from normalized accepted facts. |
| `blank` | Source field exists but contains an empty string. |
| `unavailable` | Source did not publish/provide the field, with a reason. |
| `null` | Source explicitly supplied null. |
| `present(0)` | Source supplied numeric zero; it must not be confused with the other three states. |

## Configuration example

This is the fixture composition input shape, not a file automatically loaded by the CLI:

```js
{
  mode: 'local',
  providerId: 'fixture-provider',
  allowedHosts: ['fixture.example'],
  rawStore: 'memory',
  eligibilityPredicate: 'To == 2026',
  targetEndingYears: [2022, 2023, 2024, 2025, 2026],
  publication: 'private',
  policy: {
    minIntervalMs: 6000,
    maxRequestsPerMinute: 10,
    hostConcurrency: 1,
    userAgent: 'web-scraper-fixture (+local@example.com)'
  }
}
```

Production worker configuration additionally requires a matching authorization and versioned data contract. The current `start:worker` command validates those gates and exits because no production source adapter is installed. Do not infer provider authorization from passing fixtures.

## Dependency ownership

```text
                  application composition/orchestrator
                    |       |       |       |       |
                    v       v       v       v       v
                 Fetcher Discovery Parsers Domain Persistence
                    |                         ^         |
                    v                         |         v
              transport/raw store         contracts  read projections --> API/UI
```

Only Fetcher owns upstream transport. Discovery and Parsers transform snapshots; Domain normalizes parsed documents; Persistence owns durable writes and read projections; API/UI reads projections only. `BOUNDARY_CONTRACTS.md` freezes the package entry points and import rules.

| Later package epic | Frozen input | Frozen output | Fixture to preserve | Ownership / exclusion |
| --- | --- | --- | --- | --- |
| Fetcher | Canonical job, lease, request policy, transport/raw-store ports | Typed fetch result and verified immutable raw reference | 429/challenge/5xx/304/redirect | Owns HTTP, pacing, cache, raw finalization; never parses. |
| Discovery | Page type, snapshot, parsed link document | Child manifest jobs, observations, unavailable coverage | Actual-link chain, partial history, off-host URL | Owns link intent; never fetches or writes storage. |
| Parsers | Immutable raw snapshot and parser version | Valid document or structural failure with warnings | Five page types, shifted layout | Owns source extraction; never normalizes or commits. |
| Domain normalization | Parsed document, page type, canonical context | Normalized page and explicit source-value/status semantics | Final/neutral/overtime/canceled/rescheduled/incomplete, zero/null | Owns facts; never calls transport or query API. |
| Persistence | Leased page, provenance, staged observations/jobs | Atomic page transition, repair inventory, stable read projections | Duplicate URL, two-sided game, stale lease, conflicting reparse | Owns SQL/raw adapters and transaction mapping; not provider selectors. |
| API/UI | Read-only query port and publication gate | School/season/game/health views | Worker-stopped local reads, denied mutation/publication | Owns presentation only; never claims jobs or fetches. |

## PostgreSQL migration smoke — verified

`npm run smoke:migrations` is an executable check for a **disposable** PostgreSQL database with `psql` installed. It applies every ordered migration twice, then verifies `schema_migrations` exactly matches the files. It refuses to run unless `PG_SMOKE_CONFIRM=disposable` and `PGHOST`, `PGDATABASE`, and `PGUSER` are set. Connection settings are not printed. It creates schema objects and must not target a database containing user data.

On September 23, 2026, the smoke ran against an isolated disposable PostgreSQL 14 cluster. No connection values or credentials were recorded. Output:

```text
migration pass 1 completed (7 files)
migration pass 2 completed (7 files)
migration smoke passed: 7 versions, repeat-safe
```

`npm run test:postgres` subsequently passed against the same disposable cluster with `PG_TEST_CONFIRM=disposable`. It exercises exclusive claims, generation fencing, active-request cancellation, malformed row rejection by database constraints, atomic rollback, idempotent and conflicting page writes, basketball domain table mappings, two-sided canonical games, read projections, and a child process killed after parse recording but before page commit. The replacement process recovered the expired claim, finished all six fixture games, and left the already parsed school index at one attempt. The fixture source made no external upstream request. The PostgreSQL driver is pinned in `package-lock.json`; `npm audit --omit=dev` reported zero vulnerabilities when added.

## Implementation handoff checklist

- [x] Fixture/local command reports readiness and completes without source traffic.
- [x] Comprehensive HTML fixture chain and fault variant are deterministic and repeat-safe.
- [x] Reconciliation names exact unresolved or quarantined records.
- [x] Public boundary imports and API read isolation are tested.
- [x] Six package boundaries have distinct inputs, outputs, fixture ownership, and exclusions.
- [x] Run migration smoke on a disposable PostgreSQL instance.
- [ ] Install a licensed/authorized provider adapter and agreed field contract before any real crawl.
- [x] Implement durable PostgreSQL repositories and validate process-level worker restart against them.
