# URL identity and host allowlisting

Source URLs are provider-scoped immutable values. They must be HTTPS URLs without credentials or fragments; fragments are not fetchable resource identity and credentials must never reach transport. Allowlisting reparses the absolute URL rather than trusting copied metadata, so a tampered `host` field cannot bypass the configured host set.

Canonical paths normalize duplicate slashes, trailing slashes, host casing, and query key/value ordering while retaining the provider identifier. Job and game keys serialize that provider-scoped canonical path, preventing cross-provider collisions.

Discovery validates every linked URL before canonicalization or queueing. Unsafe school, season, game-log, and box-score links become rejected observations; they do not create jobs or canonical game identities. Fetcher validation repeats the same checks before the initial request and before every manually handled redirect.
