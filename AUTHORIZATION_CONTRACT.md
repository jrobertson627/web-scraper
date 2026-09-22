# Authorization and retained-data contract

Issue #5 makes provider permissions and publication rights executable configuration gates.

An authorization record is provider-scoped and must identify its intended uses (`crawl` and/or `publish`), effective and expiry/revocation dates, the approved crawl scope, the matching contract version and fingerprint, and a private `evidenceRef`. The evidence reference is only used for validation; it is never returned by diagnostics or read models.

A data contract is immutable and fingerprinted. It identifies the provider and version, retained fields, attribution, source-link requirements, redistribution policy, retention requirement, and optional effective/expiry/revocation dates. Public publication requires `redistribution: public`.

Worker and public API startup fail closed when either gate is absent, expired, revoked, provider-mismatched, scope-mismatched, or tied to a different contract version/fingerprint. Local fixture mode remains available without authorization and is always private; it uses only the fixture transport.

The worker accepts JSON records through `AUTHORIZATION_JSON` and `DATA_CONTRACT_JSON`. Validation errors name the failed field and a safe correction pattern without echoing credential or evidence contents.
