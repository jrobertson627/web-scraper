// Structured crawl logging at the worker/application boundary. The fetcher and
// orchestrator receive an injected `events` sink and call events.emit(name,
// fields); parsers, discovery and domain normalization never see it. The sink
// writes one JSON object per line and keeps running counters, so a supervised
// run or a backfill leaves a greppable log plus periodic crawl.summary lines.
//
// Logged fields are job keys, page types, hosts, codes, counts and timings.
// Configuration and environment values are never logged (DEPLOYMENT.md).

export const NO_CRAWL_EVENTS = Object.freeze({ emit() {} });

export const CRAWL_COUNTERS = Object.freeze([
  'requestsStarted', 'cacheHits', 'notModified', 'throttlePauses', 'throttleWaitMs', 'retryWaits', 'challengeStops',
  'operatorStops', 'permanentFailures', 'parsed', 'parseWarnings', 'parseFailures', 'discoveredChildren',
  'duplicateDiscoveries', 'mergeConflicts', 'reconciliationFailures',
]);

function settledFields(event) {
  return {
    jobKey: event.jobKey, pageType: event.pageType, kind: event.kind, code: event.code, phase: event.phase,
    reason: event.reason, nextAllowedAt: event.nextAllowedAt, warnings: event.warnings?.length ?? 0,
    reconciliationIssues: event.reconciliationIssues ?? 0,
  };
}

export function createCrawlLog({
  write = (line) => process.stderr.write(`${line}\n`),
  clock = () => new Date(),
  summaryEvery = 100,
} = {}) {
  const counters = Object.fromEntries(CRAWL_COUNTERS.map((name) => [name, 0]));
  const byPageType = {};
  // Duplicate discovery is judged within this process; persistence still
  // deduplicates jobs durably on their canonical key across restarts.
  const discovered = new Set();
  let settled = 0;

  function line(event, fields) {
    const entry = { at: clock().toISOString(), event };
    for (const [key, value] of Object.entries(fields)) if (value !== undefined) entry[key] = value;
    try { write(JSON.stringify(entry)); } catch { /* logging must never stop the crawl */ }
  }

  function summary(extra = {}) {
    line('crawl.summary', { counters: { ...counters }, settledByPageType: structuredClone(byPageType), ...extra });
  }

  function emit(event, fields = {}) {
    let logged = fields;
    if (event === 'request.started') counters.requestsStarted += 1;
    else if (event === 'cache.hit') counters.cacheHits += 1;
    else if (event === 'cache.not_modified') counters.notModified += 1;
    else if (event === 'throttle.paused') {
      counters.throttlePauses += 1;
      counters.throttleWaitMs += fields.waitMs ?? 0;
    } else if (event === 'page.discovered') {
      const children = fields.childKeys ?? [];
      const duplicates = children.filter((key) => discovered.has(key)).length;
      for (const key of children) discovered.add(key);
      counters.discoveredChildren += children.length - duplicates;
      counters.duplicateDiscoveries += duplicates;
      logged = { jobKey: fields.jobKey, pageType: fields.pageType, children: children.length, duplicates };
    } else if (event === 'job.settled') {
      logged = settledFields(fields);
      const kind = logged.kind;
      if (kind === 'parsed') counters.parsed += 1;
      if (kind === 'retry_wait') counters.retryWaits += 1;
      if (kind === 'operator_stop') counters.operatorStops += 1;
      if (kind === 'operator_stop' && logged.code === 'challenge') counters.challengeStops += 1;
      if (kind === 'permanently_failed') counters.permanentFailures += 1;
      if (kind === 'parse_failed') counters.parseFailures += 1;
      counters.parseWarnings += logged.warnings;
      counters.mergeConflicts += logged.reconciliationIssues;
      const pageType = logged.pageType ?? 'unknown';
      byPageType[pageType] ??= {};
      byPageType[pageType][kind] = (byPageType[pageType][kind] ?? 0) + 1;
      settled += 1;
    } else if (event === 'reconciliation.completed') {
      counters.reconciliationFailures += (fields.failedChecks ?? 0) + (fields.quarantined ?? 0);
    }
    line(event, logged);
    if (event === 'job.settled' && summaryEvery > 0 && settled % summaryEvery === 0) summary();
  }

  return Object.freeze({
    emit,
    summary,
    counters: () => Object.freeze({ ...counters }),
  });
}

// Job-state counts for a crawl.summary line, from the jobs a run returns.
export function jobStateCounts(jobs) {
  const counts = {};
  for (const job of jobs) counts[job.state] = (counts[job.state] ?? 0) + 1;
  return counts;
}
