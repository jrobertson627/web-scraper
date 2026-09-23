# Authorization and retained-data contract

The authorization and data-contract records are executable configuration gates. They check the claims in the records; they do not verify a provider's permission independently.

An authorization record identifies its provider, intended uses (`crawl` and/or `publish`), effective and expiry/revocation dates when applicable, crawl scope, matching contract version and fingerprint, and an `evidenceRef`. An externally granted record uses `evidenceRef` to locate the grant. The reference is never returned in diagnostics or read models.

The data contract is immutable and fingerprinted. It identifies the provider and version, retained fields, attribution, source-link requirements, redistribution policy, and retention statement. Public publication requires a separate `publish` authorization and `redistribution: public`.

Worker and public API startup fail closed when a required record is absent, expired, revoked, provider-mismatched, scope-mismatched, or tied to a different contract version/fingerprint. Local fixture mode remains available without either record and is always private.

## Milestone 1: personal, private configuration

The checked-in records at `config/personal-use.authorization.json` and `config/personal-use.data-contract.json` describe a single operator's personal, non-commercial, private use. The authorization record has `basis: personal_use_attestation`, `uses: ["crawl"]`, and an `operator-attestation:` evidence reference. This is the operator's declaration of intended use and scope, **not evidence of a written grant from Sports Reference**. The data contract sets `redistribution: private`, lists the planned retained fields, and specifies local retention under the operator's control.

The configuration validator rejects a personal-use attestation for `publish`, rejects any additional use in that record, and requires a private data contract. No public API or UI is authorized by these records. A change to retained fields requires a new contract version and matching fingerprint. The project still needs to follow the provider's current terms and request policy before any live crawl; clearing this configuration gate alone does not establish permission or start a crawl.

The worker accepts JSON through `AUTHORIZATION_JSON` and `DATA_CONTRACT_JSON`. `npm run start:worker:personal` loads the checked-in records into those variables, sets the matching provider and host, and calls the same worker startup path. Set `USER_AGENT` to a transparent application/contact value and `RAW_STORE_ROOT` to an absolute directory on a persistent local volume before running it. Today, an accepted configuration exits `4` because no production source adapter is installed; rejection exits `3`. Validation errors name the failed field without echoing evidence contents.

## Private attribution and source links

Sports Reference's [Terms of Use, section 5](https://www.sports-reference.com/termsofuse.html) encourages crediting Sports Reference as the source when using data from its pages. Its [Data Use guidance](https://www.sports-reference.com/data_use.html) discusses restrictions on scraped-data tools and bulk reuse. Neither page supplies a mandatory exact phrase or placement for this private read surface. The following is this project's convention, not a claim of a negotiated license term:

- Display **Source: Sports Reference** on every private page or view containing provider-derived data, and include the same attribution in API projections that expose those data.
- Include a direct **View source** link beside a school, season, game, or box-score detail. Use its retained `sourceUrl` provenance value: the original canonical HTTPS provider page URL. Do not build a link from names or dates.
- Keep the read surface bound to local/private access for one operator. Do not publish the API, UI, database, raw snapshots, or exports under this contract.

M7 API projections and M9 UI work should use this section for attribution and source-link behavior. Public redistribution requires a separate scope decision and qualifying authorization/data contract.
