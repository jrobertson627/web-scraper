# URL identity and host allowlisting

Source URLs are provider-scoped immutable values. They must be HTTPS URLs without credentials or fragments; fragments are not fetchable resource identity and credentials must never reach transport. Allowlisting reparses the absolute URL rather than trusting copied metadata, so a tampered `host` field cannot bypass the configured host set.

Canonical paths normalize duplicate slashes, trailing slashes, host casing, and query key/value ordering while retaining the provider identifier. Job and game keys serialize that provider-scoped canonical path, preventing cross-provider collisions.

Discovery validates every linked URL before canonicalization or queueing. Unsafe school, season, game-log, and box-score links become rejected observations; they do not create jobs or canonical game identities. Fetcher validation repeats the same checks before the initial request and before every manually handled redirect.

## Sports Reference

`SportsReferenceSourceAdapter` (`src/application/sports-reference-source-adapter.mjs`) is the production adapter. Its provider id is `sports-reference` and its only host is `www.sports-reference.com`. It classifies exactly the published page shapes and throws for anything else, including query strings:

| Path | Page type |
| --- | --- |
| `/cbb/schools/` | `school_index` (the root job) |
| `/cbb/schools/<slug>/men/` | `school_history` |
| `/cbb/schools/<slug>/men/<year>.html` | `season` |
| `/cbb/schools/<slug>/men/<year>-gamelogs.html` | `game_log` |
| `/cbb/boxscores/<date>-<hour>-<slug>.html` | `box_score` |

It refuses the paths robots.txt disallows, `/cbb/boxscores/index.cgi` (with or without a query), `/cbb/req/`, `/cbb/short/` and `/cbb/nocdn/`, in `classify`, `canonicalize` and `schoolUrl`. Before each bulk run, fetch robots.txt and pass it to `unrefusedRobotsRules`; a non-empty result lists new `/cbb/` rules the adapter must learn before crawling.

A school's identity is its men's history path. Opponent and scorebox links point at the team's season page, so `schoolUrl` drops `<year>.html` (or `<year>-gamelogs.html`) to get it. That derived path is used only for identity. It is never queued.

## Discovery rules

Discovery follows only links the page publishes. It never builds a URL from a year range, a date or a display name. With a source adapter (worker mode), each child link must classify as the expected page type; a mismatched or refused link becomes a `rejected_url` observation and no job.

**Redirects (#124).** The Fetcher follows up to `maxRedirects` redirects, checking each target against the allowlist. The URL a fetch ends at is recorded on the source fetch (`source_fetches.final_url`, when it differs from the queued URL), and the page's relative links are resolved against it, since that is where the body was served from. If the final URL canonicalizes to a **different page** than the job names (a school renamed, an unrelated page), the body is kept with both URLs on record, but the page is not parsed under the old identity: the job stops as `operator_stop` with code `redirected_identity`, and its reason names both URLs. This is a page-level stop; it does not halt the run. A redirect that ends at the same canonical page (query order, for example) is parsed normally.

1. School index: every row is observed with its eligibility; a history job is queued only for schools whose `To` is the current season's ending year.
2. School history: linked seasons in the target window (the five ending years up to the current season, 2022-2026 for the 2025-26 season) are queued. A target season the page does not link is recorded as unavailable coverage (`not_linked`, or `link_rejected` when its link was refused), not as a failure.
3. Season: the published game-log link is queued; a season without one produces a warning.
4. Game log: every row is observed, including incomplete rows, with `canonicalBoxScorePath` and `opponentSchoolSourcePath` (`null` for an unlinked opponent). Only a row's published box-score link creates a job. Opponents are never crawled.
5. Box score: observed with each team's `schoolSourcePath`; no jobs. Previous/next game links are ignored.

A box score linked from both teams' game logs has one canonical path and so one job.
