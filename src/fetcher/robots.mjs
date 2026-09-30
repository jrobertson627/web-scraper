// robots.txt, rechecked while the crawl runs (#131).
//
// Before a bulk run an operator checks the provider's robots.txt by hand
// (`npm run robots:check`). A backfill takes days, and the file can change in
// that time. So the Fetcher fetches it at the start of each run and then at an
// interval (a day by default), through the same paced transport and under the
// same host lock as any page, and the run halts when what it says no longer
// matches what the crawler refuses.

const DAY_MS = 24 * 60 * 60 * 1000;

// The longest Crawl-delay in the file, in seconds, or null. Groups are not told
// apart: a delay under any user agent counts, which errs toward stopping.
export function crawlDelaySeconds(robotsTxt) {
  const delays = String(robotsTxt).split(/\r?\n/)
    .map((line) => /^\s*crawl-delay\s*:\s*(\d+(?:\.\d+)?)/i.exec(line.replace(/#.*/, ''))?.[1])
    .filter((value) => value !== undefined).map(Number);
  return delays.length ? Math.max(...delays) : null;
}

export class RobotsGuard {
  // evaluate(robotsTxt) lists what the provider's file asks for that the crawler
  // does not honour, such as a Disallow rule its source adapter does not refuse.
  constructor({ evaluate, intervalMs = DAY_MS }) {
    if (typeof evaluate !== 'function') throw new Error('a robots guard needs evaluate(robotsTxt)');
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 60_000) throw new Error('robots recheck interval must be at least a minute');
    this.evaluate = evaluate;
    this.intervalMs = intervalMs;
    this.checkedAt = new Map();
  }

  // True when the host's robots.txt has not been checked in this process, or not
  // within the interval.
  due(host, now) {
    const last = this.checkedAt.get(host);
    return last === undefined || now.getTime() - last >= this.intervalMs;
  }

  markChecked(host, now) { this.checkedAt.set(host, now.getTime()); }

  // What in the file the crawler cannot follow: the source's own list, and a
  // Crawl-delay longer than the request interval.
  problems(robotsTxt, { minIntervalMs }) {
    const found = [...this.evaluate(robotsTxt)];
    const delay = crawlDelaySeconds(robotsTxt);
    if (delay !== null && delay * 1000 > minIntervalMs) found.push(`sets Crawl-delay ${delay}s, longer than the ${minIntervalMs / 1000}s request interval`);
    return found;
  }
}
