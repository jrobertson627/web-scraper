# Immutable raw storage and repair

Raw bodies are content-addressed by lowercase SHA-256 checksum. `MemoryRawStore` and `FileRawStore` never expose their internal mutable buffers; reads return copies, writes are idempotent for the same checksum, and checksum/object-path verification is required before a body can be used.

The fetcher finalizes and verifies the raw object before it records a successful `source_fetch`. A missing body, checksum mismatch, or object-path mismatch therefore cannot produce a fetched or parsed job. A `304` response reuses the previously verified immutable body while recording new conditional-fetch metadata; it never overwrites the body.

## Store port and hashing once

A raw store implements `put(bytes)`, `read(checksum, expectedObjectPath?)`, `get(checksum)`, `verify(checksum, expectedObjectPath?)`, `entries()` and `temporaryEntries()` (filesystem only). `FileRawStore` uses asynchronous filesystem I/O and returns promises, so a 16 MiB write or read does not block the event loop, including the worker's lease-renewal timer. `MemoryRawStore` does no I/O and returns values directly. Callers await both.

Each fetch hashes its body once (#91):

- `put()` hashes the new body, writes it, and returns the verification of the stored object, `{ ok: true, checksum, objectPath, size }`. A byte comparison, not a second hash, proves the stored file equals the body.
- `read()` reads and hashes a stored body once and returns that verification with the verified `body`. The fetcher uses it for a cache hit and for the prior body behind a `304`.
- `recordFetch(metadata, lease, verification)` takes that verification as its proof. Both persistence adapters reject a successful fetch whose verification is missing, failed, or names a different checksum or object path, and neither reads the object again.
- The fetch result carries the verified body, so the orchestrator parses it without another read. A fetch result without a body (a stub or older fetcher) is read back from the store and checked before parsing.

`Persistence.repairRawObjects({ rawStore })` inventories every referenced object and every unreferenced object. Missing, mismatched, or conflicting references become `pending` repair records. Unreferenced objects are retained as `orphan` records for operator review rather than being silently deleted. Invalid checksum references are rejected before filesystem path resolution.

Raw snapshots can be read directly from the store for offline parser reprocessing; no transport request or new body is required.

## Filesystem adapter

Select `filesystem` with an explicit absolute `rawStoreRoot` (the worker reads `RAW_STORE_ROOT`). Keep this directory on a persistent local volume and restrict write access to the worker. `FileRawStore` writes a uniquely named temporary file in the checksum's directory, flushes its bytes, and publishes it with a no-overwrite hard link. It then compares the final file with the body before a successful fetch can be recorded. On platforms where Node can open directory handles, it also flushes the checksum directory and store root. Windows does not expose a portable directory-flush operation through Node, so the file is flushed but directory-entry durability across sudden power loss depends on the filesystem. The repair scan detects a missing final object after restart.

An interrupted write may leave a `.tmp` file. Temporary files never appear in `get()` or the completed-object inventory and are never deleted automatically. The repair report lists them with paths and modification times for operator review.

## Repair report

`persistence.repairRawObjects({ rawStore })` compares all `source_fetches` references with the real store. Both adapters build the report with one function, `inventoryRawObjects`, so they return the same shape; PostgreSQL also records pending and orphan findings in `raw_object_repair`. Its JSON-serializable result includes `counts` and identifier-bearing `healthy`, `pending`, `orphans`, and `temporary` arrays. Pending records distinguish missing files, checksum mismatches, missing paths, and conflicting paths; they include all affected source-fetch IDs. Orphans are retained. The scan changes neither raw objects nor `source_fetches`; an operator can use the report to plan a separate repair action. A missing or mismatched body fails verification and cannot reach parsing.
