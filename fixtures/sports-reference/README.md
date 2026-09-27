# Real Sports Reference captures

Raw HTML captured from sports-reference.com for discovery and parser regression tests (#38). These are real-provider captures, distinct from the synthetic pages in `fixtures/foundation-corpus.mjs`.

The raw pages in `raw/` are **not committed**. The repository is public, and the data contract (`config/personal-use.data-contract.json`) sets `redistribution: private`. Only `manifest.json` is committed. It records each page's URL, fetch time, size and SHA-256, so a local copy can be checked against it. Tests that need these pages must skip when `raw/` is missing.

## Recapturing

```bash
MSYS_NO_PATHCONV=1 USER_AGENT="web-scraper (+your-contact)" node scripts/capture-fixtures.mjs /cbb/schools/duke/men/2024.html
```

`MSYS_NO_PATHCONV=1` is only needed in Git Bash on Windows. The script waits at least 7 seconds between requests, skips paths already in the manifest, and stops on any non-200 response, redirect, or challenge. A later recapture may differ from the recorded hash if the page changed upstream.

## Cases covered

| Case | Path |
|---|---|
| School index | `/cbb/schools/` |
| Full historical coverage | `/cbb/schools/duke/men/` |
| Partial coverage (joined D-I for 2024) | `/cbb/schools/le-moyne/men/` |
| Season, NCAA tournament team | `/cbb/schools/duke/men/2024.html` |
| Season, non-tournament team | `/cbb/schools/le-moyne/men/2024.html` |
| Game log, home/away/neutral rows | `/cbb/schools/duke/men/2024-gamelogs.html` |
| Game log, unlinked opponents and an incomplete row (2024-01-20, no score or box link) | `/cbb/schools/le-moyne/men/2024-gamelogs.html` |
| Home game | `/cbb/boxscores/2024-01-27-16-duke.html` |
| Away game | `/cbb/boxscores/2024-02-03-18-north-carolina.html` |
| Neutral site (NCAA Sweet 16) | `/cbb/boxscores/2024-03-29-21-houston.html` |
| Overtime | `/cbb/boxscores/2024-02-15-19-le-moyne.html` |
| Unlinked (non-D-I) opponent | `/cbb/boxscores/2023-11-13-19-le-moyne.html` |

Not yet covered: a canceled or rescheduled game with an explicit status label.
