# Parser and normalization contracts

Parsers are registered by `(pageType, version)` and consume immutable raw snapshots. Registration requires `pageType()`, `version()`, and `parse(snapshot)`; duplicate or unknown versions fail deterministically. Parse results are immutable and explicitly distinguish valid documents from structural failures while retaining warnings. Every valid document must match its page type's frozen shape in [`PARSED_DOCUMENTS.md`](PARSED_DOCUMENTS.md); one that does not is returned as a structural failure.

Source values preserve four distinct states: blank, unavailable, explicit null, and present. `present(0)` remains a real numeric zero. Normalized game records likewise retain explicit status, context, nullable source identities, scores, line scores, and parser warnings without inventing links or identities.

Parser upgrades can reprocess an existing raw snapshot without transport access. Each accepted or quarantined normalized revision carries its source-fetch and parser lineage. When a reprocess conflicts with an accepted fact, the accepted projection remains stable, both provenance lineages are retained, and a reconciliation issue records the conflict instead of silently overwriting data.
