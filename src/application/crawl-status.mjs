// `cli.mjs status`: progress by page type, request pace, and projected time
// remaining, computed from a persistence crawlStatus() snapshot.

export const STATUS_WINDOW_MS = 60 * 60 * 1000;
const DONE = new Set(['parsed']);
const FAILED = new Set(['parse_failed', 'permanently_failed']);
const BLOCKED = new Set(['operator_stop']);
const PAGE_TYPE_ORDER = ['school_index', 'school_history', 'season', 'game_log', 'box_score'];

function rank(pageType) {
  const index = PAGE_TYPE_ORDER.indexOf(pageType);
  return index === -1 ? PAGE_TYPE_ORDER.length : index;
}

// minIntervalMs is the request policy's floor between request starts; it caps
// the pace and stands in for it before any request has been made.
export function summarizeCrawlStatus(status, { minIntervalMs = 6000 } = {}) {
  const byType = new Map();
  for (const { pageType, state, count } of status.jobs) {
    const entry = byType.get(pageType) ?? { pageType, total: 0, done: 0, failed: 0, blocked: 0, remaining: 0, states: {} };
    entry.total += count;
    entry.states[state] = (entry.states[state] ?? 0) + count;
    if (DONE.has(state)) entry.done += count;
    else if (FAILED.has(state)) entry.failed += count;
    else if (BLOCKED.has(state)) entry.blocked += count;
    else entry.remaining += count;
    byType.set(pageType, entry);
  }
  const pageTypes = [...byType.values()].sort((a, b) => rank(a.pageType) - rank(b.pageType) || a.pageType.localeCompare(b.pageType));
  const totals = pageTypes.reduce((sum, entry) => ({
    total: sum.total + entry.total, done: sum.done + entry.done, failed: sum.failed + entry.failed,
    blocked: sum.blocked + entry.blocked, remaining: sum.remaining + entry.remaining,
  }), { total: 0, done: 0, failed: 0, blocked: 0, remaining: 0 });

  const observedAt = Date.parse(status.observedAt);
  const { inWindow, windowMs, firstAt, lastAt, total: requests } = status.fetches;
  // A crawl younger than the window is measured over its own age.
  const windowStart = Math.max(observedAt - windowMs, firstAt ? Date.parse(firstAt) : observedAt);
  const measuredMs = observedAt - windowStart;
  const policyPerHour = 3_600_000 / minIntervalMs;
  const observedPerHour = inWindow > 0 && measuredMs > 0 ? inWindow / (measuredMs / 3_600_000) : null;
  const perHour = Math.min(observedPerHour ?? policyPerHour, policyPerHour);
  return Object.freeze({
    observedAt: status.observedAt,
    pageTypes,
    totals,
    pace: {
      requests, requestsInWindow: inWindow, windowMs, lastRequestAt: lastAt,
      observedPerHour: observedPerHour === null ? null : Math.round(observedPerHour * 10) / 10,
      policyPerHour: Math.round(policyPerHour * 10) / 10,
      basis: observedPerHour === null ? 'policy' : 'observed',
    },
    // Only jobs already discovered are counted, so while discovery is still
    // queueing children this is a lower bound.
    projection: {
      remainingJobs: totals.remaining,
      remainingMs: Math.round((totals.remaining / perHour) * 3_600_000),
      lowerBound: true,
    },
  });
}

function duration(ms) {
  const minutes = Math.round(ms / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const parts = [days && `${days}d`, (days || hours) && `${hours}h`, `${minutes % 60}m`].filter(Boolean);
  return parts.join(' ');
}

function percent(part, whole) {
  return whole ? `${((part / whole) * 100).toFixed(1)}%` : '-';
}

export function formatCrawlStatus(summary) {
  const rows = [['page type', 'total', 'done', 'failed', 'blocked', 'remaining', 'progress'],
    ...[...summary.pageTypes, { pageType: 'all', ...summary.totals }].map((entry) => [entry.pageType, entry.total, entry.done,
      entry.failed, entry.blocked, entry.remaining, percent(entry.done + entry.failed, entry.total)].map(String))];
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));
  const table = rows.map((row) => row.map((cell, column) => (column ? cell.padStart(widths[column]) : cell.padEnd(widths[column]))).join('  '));
  const { pace, projection } = summary;
  const windowMinutes = Math.round(pace.windowMs / 60_000);
  return [
    `crawl status at ${summary.observedAt}`,
    '',
    ...table,
    '',
    `requests: ${pace.requests} total, ${pace.requestsInWindow} in the last ${windowMinutes} min; last at ${pace.lastRequestAt ?? 'never'}`,
    `pace: ${pace.observedPerHour === null ? 'no recent requests' : `${pace.observedPerHour}/h observed`} (policy ceiling ${pace.policyPerHour}/h)`,
    `projected time remaining: at least ${duration(projection.remainingMs)} for ${projection.remainingJobs} known jobs at the ${pace.basis} pace`,
  ].join('\n');
}
