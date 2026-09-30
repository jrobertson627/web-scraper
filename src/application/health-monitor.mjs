// Tells one page's failure from the whole crawl's (#114).
//
// A transport error, a 5xx or an infrastructure error is charged to the page it
// happened on. When the cause is not the page (the site is down, the worker's
// network or DNS is, the disk is failing), every page fails the same way, and
// charging each one wears out its retries within minutes and loses whole
// subtrees. So the run watches for failures across different pages: after
// `failuresToOpen` in a row it stops charging, pauses, and backs off (5 minutes
// doubling to 2 hours). After a pause one request probes; a failure re-opens the
// pause at once, and a success closes it. After `opensToHalt` pauses in a row
// with no success in between it halts the run for an operator.
//
// A success (a page fetched and parsed) resets everything. Failures that name
// the page itself (a 404, a parse failure, a 429) are not counted at all.

export class HealthMonitor {
  constructor({ failuresToOpen = 3, pauseBaseMs = 300_000, pauseMaxMs = 7_200_000, opensToHalt = 5, clock = () => new Date() } = {}) {
    for (const [name, value] of [['failuresToOpen', failuresToOpen], ['pauseBaseMs', pauseBaseMs], ['pauseMaxMs', pauseMaxMs], ['opensToHalt', opensToHalt]]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error(`health.${name} must be a positive integer`);
    }
    this.failuresToOpen = failuresToOpen;
    this.pauseBaseMs = pauseBaseMs;
    this.pauseMaxMs = Math.max(pauseBaseMs, pauseMaxMs);
    this.opensToHalt = opensToHalt;
    this.clock = clock;
    this.failures = [];
    this.opens = 0;
    this.probing = false;
    this.pausedUntil = null;
  }

  // The time the run must wait until, or null.
  waitUntil() {
    return this.pausedUntil && this.pausedUntil.getTime() > this.clock().getTime() ? this.pausedUntil : null;
  }

  // A failure that says nothing about its page. Returns what to do with the page:
  // { action: 'charge' } (an ordinary failure: charge it), { action: 'pause',
  // pauseUntil, opens } (put it back uncharged and wait), or { action: 'halt',
  // pauseUntil, opens } (put it back uncharged and end the run).
  recordFailure(jobKey) {
    this.failures.push(jobKey);
    const opening = this.probing || (this.failures.length >= this.failuresToOpen && new Set(this.failures).size >= 2);
    if (!opening) return { action: 'charge' };
    this.opens += 1;
    this.failures = [];
    this.probing = true;
    const pauseMs = Math.min(this.pauseBaseMs * (2 ** (this.opens - 1)), this.pauseMaxMs);
    this.pausedUntil = new Date(this.clock().getTime() + pauseMs);
    return { action: this.opens >= this.opensToHalt ? 'halt' : 'pause', pauseUntil: this.pausedUntil, opens: this.opens };
  }

  // A page was fetched and parsed: the infrastructure works.
  recordSuccess() {
    this.failures = [];
    this.opens = 0;
    this.probing = false;
    this.pausedUntil = null;
  }
}
