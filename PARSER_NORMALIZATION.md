# Parser and normalization contracts

Parsers are registered by `(pageType, version)` and consume immutable raw snapshots. Registration requires `pageType()`, `version()`, and `parse(snapshot)`; duplicate or unknown versions fail deterministically. Parse results are immutable and explicitly distinguish valid documents from structural failures while retaining warnings. Every valid document must match its page type's frozen shape in [`PARSED_DOCUMENTS.md`](PARSED_DOCUMENTS.md); one that does not is returned as a structural failure.

Source values preserve four distinct states: blank, unavailable, explicit null, and present. `present(0)` remains a real numeric zero. Normalized game records likewise retain explicit status, context, nullable source identities, scores, line scores, and parser warnings without inventing links or identities.

Parser upgrades can reprocess an existing raw snapshot without transport access. Each accepted or quarantined normalized revision carries its source-fetch and parser lineage.

## Offline reprocessing

`npm run reprocess` (or `npm run reprocess:personal` with the checked-in private-use records) parses settled jobs' stored raw snapshots again and commits the results. It needs `PERSISTENCE=postgres` and `RAW_STORE_ROOT`, and passes the same configuration gate as the worker because it writes provider-derived records. It builds no Fetcher and takes no transport, so it cannot make an upstream request. Select jobs with `--page-type <type>` and `--state parsed|parse_failed` (each takes one value or a comma-separated list and may repeat; the default is every parsed and parse_failed job), or name jobs with `--job <job key>`. It prints a summary: jobs selected, accepted, superseded, held as conflicts, parse failures, and parse_failed jobs promoted to parsed, with up to 20 example job keys for each problem.

For each job, reprocessing verifies the latest stored snapshot (`lastSuccessfulFetch`), parses it with the configured parser version, and runs discovery and normalization as the worker does. `commitReprocess` then records the parse run and commits the page in one transaction, taking no lease, because a settled job is never claimed. A structural failure is recorded as a parse run, and the job's state and accepted record stay as they are. A `parse_failed` job whose page is accepted becomes `parsed` (the only way out of `parse_failed`), and the child jobs its page links to are queued for the worker.

Parser versions come from `PARSER_VERSIONS`, a JSON object that overrides some page types (for example `{"box_score":"2"}`); the rest stay at `1`. The worker and reprocessing both parse every job with the configured version for its page type, including jobs queued before an upgrade. Both refuse to start if a configured `pageType@version` has no production parser.

## Decision: resolving re-parse differences

**Status:** accepted (issue #43).

**Context.** A new revision of a record can differ from the accepted one for two reasons: the source changed (a refetch returned a different body), or the parser changed (an upgrade reads the same body differently). Until now both were quarantined as `conflicting_page_reprocess`, and nothing could accept them, so a parser upgrade that changed any output could never reach the normalized tables.

**Decision.** The raw bytes tell the two apart. A revision **supersedes** the accepted one when it was parsed from the same raw body (same checksum, whichever fetch recorded it: a 200, a 304 or a cache hit) by a different parser name or version, and it becomes the accepted revision. Any other difference, a different body under any parser, is **quarantined** as before: the accepted projection stays, both lineages are kept, and a `conflicting_page_reprocess` issue waits for an operator (#48). Both adapters apply the rule in the shared page-commit path, so it holds for the worker and for offline reprocessing alike. In practice only reprocessing produces a new parser's revision of an existing record, because a parsed job is never fetched again.

A superseding revision replaces the record's row sets in PostgreSQL rather than upserting over them: a season's roster, player and team season stats; a game log's rows and their stats; a game's sides, team and player stats; and a game log page's game observations. Rows the new parser no longer emits are therefore removed. Identity-keyed rows (schools, school seasons, players, `team_seasons`, `games`) are upserted as before. The older accepted revision stays in `normalized_page_revisions` as history, and the latest accepted revision is the current one.

**Consequences.** An upgrade or a rollback takes effect by changing `PARSER_VERSIONS` and running `npm run reprocess`, with no refetch. A parser version is a code change with fixtures and tests, so its output is reviewed in the pull request that adds it, not record by record. A source change still needs a person to look at it. A reprocess over a body that changed since the accepted revision is held as a conflict, even with a new parser version, so a parser upgrade can never slip a source change through.
