# Source request policy

`validateConfiguration` produces an immutable configuration for the exact intake scope: `To == 2026` and ending years 2022 through 2026. It validates the provider, host allowlist, storage, parser versions, claim timeout, GET method, HTTPS scheme, manual redirects, and the request policy. The Fetcher validates the same request policy when constructed directly.

Requests are sequential per host, at least six seconds apart, and limited to ten starts per minute. The policy includes a transport timeout, bounded redirect count, maximum attempts, bounded exponential retry delay, and optional cache freshness. The transport receives `timeoutMs` and must settle or cancel its request before returning; request ownership is released only when it settles. Host ownership and pacing use the host parsed from the URL.

A fresh, checksum verified cache entry can be reused without transport. Stale entries send conditional headers; a 304 reuses the verified immutable body and records a new fetch. A 429 with a valid `Retry-After` delays at least the minimum interval. Missing or invalid `Retry-After`, challenges, and disallowed redirects stop for operator review. 5xx responses retry within the configured attempt and delay bounds.
