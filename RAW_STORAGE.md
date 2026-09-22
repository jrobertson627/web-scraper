# Immutable raw storage and repair

Raw bodies are content-addressed by lowercase SHA-256 checksum. `MemoryRawStore` and `FileRawStore` never expose their internal mutable buffers; reads return copies, writes are idempotent for the same checksum, and checksum/object-path verification is required before a body can be used.

The fetcher finalizes and verifies the raw object before it records a successful `source_fetch`. A missing body, checksum mismatch, or object-path mismatch therefore cannot produce a fetched or parsed job. A `304` response reuses the previously verified immutable body while recording new conditional-fetch metadata; it never overwrites the body.

`Persistence.repairRawObjects({ rawStore })` inventories every referenced object and every unreferenced object. Missing, mismatched, or conflicting references become `pending` repair records. Unreferenced objects are retained as `orphan` records for operator review rather than being silently deleted. Invalid checksum references are rejected before filesystem path resolution.

Raw snapshots can be read directly from the store for offline parser reprocessing; no transport request or new body is required.
