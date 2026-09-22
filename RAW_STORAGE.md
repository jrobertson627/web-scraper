# Immutable raw storage and repair

Raw bodies are content-addressed by lowercase SHA-256 checksum. `MemoryRawStore` and `FileRawStore` never expose their internal mutable buffers; reads return copies, writes are idempotent for the same checksum, and checksum/object-path verification is required before a body can be used.

The fetcher finalizes and verifies the raw object before it records a successful `source_fetch`. A missing body, checksum mismatch, or object-path mismatch therefore cannot produce a fetched or parsed job. A `304` response reuses the previously verified immutable body while recording new conditional-fetch metadata; it never overwrites the body.

`Persistence.repairRawObjects({ rawStore })` inventories every referenced object and every unreferenced object. Missing, mismatched, or conflicting references become `pending` repair records. Unreferenced objects are retained as `orphan` records for operator review rather than being silently deleted. Invalid checksum references are rejected before filesystem path resolution.

Raw snapshots can be read directly from the store for offline parser reprocessing; no transport request or new body is required.

## Filesystem adapter

Select `filesystem` with an explicit absolute `rawStoreRoot` (the worker reads `RAW_STORE_ROOT`). Keep this directory on a persistent local volume and restrict write access to the worker. `FileRawStore` writes a uniquely named temporary file in the checksum's directory, flushes its bytes, and publishes it with a no-overwrite hard link. It then verifies the final body before a successful fetch can be recorded. On platforms where Node can open directory handles, it also flushes the checksum directory and store root. Windows does not expose a portable directory-flush operation through Node, so the file is flushed but directory-entry durability across sudden power loss depends on the filesystem. The repair scan detects a missing final object after restart.

An interrupted write may leave a `.tmp` file. Temporary files never appear in `get()` or the completed-object inventory and are never deleted automatically. The repair report lists them with paths and modification times for operator review.

## Repair report

`persistence.repairRawObjects({ rawStore })` compares all `source_fetches` references with the real store. Its JSON-serializable result includes `counts` and identifier-bearing `healthy`, `pending`, `orphans`, and `temporary` arrays. Pending records distinguish missing files, checksum mismatches, missing paths, and conflicting paths; they include all affected source-fetch IDs. Orphans are retained. The scan changes neither raw objects nor `source_fetches`; an operator can use the report to plan a separate repair action. A missing or mismatched body fails verification and cannot reach parsing.
