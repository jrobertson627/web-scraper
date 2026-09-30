import { assertBoundaryPort } from '../contracts/boundaries.mjs';
import { normalizeParsedPage, parseSnapshot, snapshotFor } from './page-pipeline.mjs';

// Operator review (#48): find, inspect and act on what the crawl stopped for,
// without database access. Two kinds of item:
//
// - Jobs: parse_failed (a layout the parser could not read) and operator_stop
//   (a challenge, a rate-limit cap, a raw snapshot that failed verification).
//   An operator_stop job is held or released with a recorded disposition. A
//   parse_failed job is fixed with a new parser version and `npm run
//   reprocess` (PARSER_NORMALIZATION.md), which needs no refetch.
// - Reconciliation issues: a conflicting_page_reprocess issue holds a
//   quarantined revision (the source changed); accepting it makes that
//   revision the accepted record. Any issue can be dismissed, keeping the
//   accepted record. Accepts and dismissals are recorded with who, when and why.
//
// Actions are authorized by the persistence adapter's operator authorizer
// (OPERATOR_IDS; see src/config/operators.mjs).

export const JOB_DISPOSITIONS = Object.freeze({ hold: 'hold', 'release-retry': 'release_retry', 'release-permanent': 'release_permanent' });
const ISSUE_ID = /^issue-[1-9]\d*$/;
const DIFF_LIMIT = 40;

export function isIssueId(value) { return ISSUE_ID.test(value ?? ''); }

// Paths (a.b[2].c) where two JSON values differ, at most `limit` of them.
export function differingPaths(left, right, path = '', found = [], limit = DIFF_LIMIT) {
  if (found.length >= limit) return found;
  if (left && right && typeof left === 'object' && typeof right === 'object' && Array.isArray(left) === Array.isArray(right)) {
    const keys = Array.isArray(left)
      ? [...Array(Math.max(left.length, right.length)).keys()]
      : [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
    for (const key of keys) {
      differingPaths(left[key], right[key], Array.isArray(left) ? `${path}[${key}]` : path ? `${path}.${key}` : key, found, limit);
    }
    return found;
  }
  if (JSON.stringify(left) !== JSON.stringify(right)) found.push(path || '(whole record)');
  return found;
}

function issueSummary(issue) {
  const { details } = issue;
  if (issue.issueType === 'conflicting_page_reprocess') {
    return {
      changed: differingPaths(details.previous?.data, details.current?.data, '', [], 8),
      accepted: fetchOf(details.previous?.provenance),
      quarantined: fetchOf(details.current?.provenance),
    };
  }
  if (issue.issueType === 'conflicting_game_log_fact') {
    return { field: details.field, gameLog: details.observed, boxScore: details.canonical, sourceFetchId: details.sourceFetchId };
  }
  return {};
}

function fetchOf(provenance) {
  return provenance ? { sourceFetchId: provenance.sourceFetchId, parser: `${provenance.parserName}@${provenance.parserVersion}` } : null;
}

function nextStepsForJob(job) {
  if (job.state === 'parse_failed') {
    return [
      'Read the stored snapshot (snapshot.objectPath) and the failure, and add a parser version that reads this layout, with a fixture.',
      `Set PARSER_VERSIONS for ${job.pageType} to the new version, then: npm run reprocess -- --job ${job.key}`,
    ];
  }
  if (job.state === 'operator_stop') {
    return [
      `To try again once the cause is resolved: npm run review -- release-retry ${job.key} --operator <id> --reason "<why>"`,
      `To give up on this page: npm run review -- release-permanent ${job.key} --operator <id> --reason "<why>"`,
      `To keep it stopped and record the review: npm run review -- hold ${job.key} --operator <id> --reason "<why>"`,
    ];
  }
  return [];
}

function nextStepsForIssue(issue) {
  if (issue.status !== 'open') return [];
  const dismiss = `To keep the accepted record: npm run review -- dismiss ${issue.id} --operator <id> --reason "<why>"`;
  if (issue.issueType !== 'conflicting_page_reprocess') return [dismiss];
  return [`To take the quarantined revision: npm run review -- accept ${issue.id} --operator <id> --reason "<why>"`, dismiss];
}

// Jobs and open issues waiting for review, one page of each.
export async function listForReview({ persistence, jobs = true, issues = true, states, limit = 50, jobCursor, issueCursor }) {
  assertBoundaryPort('persistenceReview', persistence);
  const jobPage = jobs ? await persistence.reviewJobs({ ...(states ? { states } : {}), limit, cursor: jobCursor }) : { items: [], nextCursor: null };
  const issuePage = issues ? await persistence.reviewIssues({ limit, cursor: issueCursor }) : { items: [], nextCursor: null };
  return Object.freeze({
    jobs: jobPage.items.map((job) => ({ key: job.key, state: job.state, pageType: job.pageType, url: job.url, reason: job.reason,
      parser: job.lastParseRun ? `${job.lastParseRun.parserName}@${job.lastParseRun.parserVersion}` : null, updatedAt: job.updatedAt })),
    nextJobCursor: jobPage.nextCursor,
    issues: issuePage.items.map((issue) => ({ id: issue.id, issueType: issue.issueType, recordKey: issue.recordKey,
      openedAt: issue.openedAt, ...issueSummary(issue) })),
    nextIssueCursor: issuePage.nextCursor,
  });
}

// Everything known about one job (by key) or issue (by id), with next steps.
export async function showReviewItem({ persistence, id }) {
  assertBoundaryPort('persistenceReview', persistence);
  if (isIssueId(id)) {
    const issue = await persistence.getIssue(id);
    if (!issue) throw new Error(`issue ${id} does not exist`);
    const changed = issue.issueType === 'conflicting_page_reprocess'
      ? differingPaths(issue.details.previous?.data, issue.details.current?.data) : undefined;
    return Object.freeze({ kind: 'issue', ...issue, ...(changed ? { changed } : {}), nextSteps: nextStepsForIssue(issue) });
  }
  const job = await persistence.reviewJob(id);
  if (!job) throw new Error(`job ${id} is not queued. Expected a job key or an issue id from the review list`);
  return Object.freeze({ kind: 'job', ...job, nextSteps: nextStepsForJob(job) });
}

// hold, release-retry or release-permanent an operator_stop job.
export async function disposeJob({ persistence, jobKey, action, operatorId, reason, clock }) {
  const kind = JOB_DISPOSITIONS[action];
  if (!kind) throw new Error(`job action ${action} is invalid. Expected ${Object.keys(JOB_DISPOSITIONS).join(', ')}`);
  await persistence.recordOperatorDisposition(jobKey, { kind, operatorId, reason, at: clock().toISOString() });
  return Object.freeze({ jobKey, disposition: kind, operatorId, reason, state: (await persistence.getJob(jobKey))?.state ?? null });
}

// The same action on every job in the given states whose latest stop carries
// `code`, with one recorded disposition per job (#113). dryRun only lists them.
// The matching jobs are collected first, then disposed one at a time, so a
// failure part-way leaves a clear count of what was done.
export async function disposeMatching({ persistence, action, states, code, dryRun = false, operatorId, reason, clock, pageSize = 200 }) {
  const kind = JOB_DISPOSITIONS[action];
  if (!kind) throw new Error(`job action ${action} is invalid. Expected ${Object.keys(JOB_DISPOSITIONS).join(', ')}`);
  if (!states?.length || !code) throw new Error('a bulk disposition needs states and a code');
  assertBoundaryPort('persistenceReview', persistence);
  const matched = [];
  for (let cursor; ;) {
    const page = await persistence.reviewJobs({ states, limit: pageSize, cursor });
    for (const job of page.items) if (job.code === code) matched.push(job.key);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  const result = { action, disposition: kind, states, code, dryRun, matched: matched.length, disposed: 0, sample: matched.slice(0, 10) };
  if (dryRun) return Object.freeze(result);
  for (const jobKey of matched) {
    try {
      await persistence.recordOperatorDisposition(jobKey, { kind, operatorId, reason, at: clock().toISOString() });
    } catch (error) {
      throw new Error(`stopped after ${result.disposed} of ${matched.length} jobs at ${jobKey}: ${error.message}`, { cause: error });
    }
    result.disposed += 1;
  }
  return Object.freeze(result);
}

export async function dismissIssue({ persistence, issueId, operatorId, reason, clock }) {
  if (!isIssueId(issueId)) throw new Error(`issue id ${issueId} is invalid. Expected an id from the review list. Example: issue-12`);
  return persistence.dismissIssue({ issueId, operatorId, reason, at: clock() });
}

// Accepts the quarantined revision an open conflicting_page_reprocess issue
// holds. The page is derived again from that revision's own stored snapshot
// with the parser version that produced it, so its observations, child links
// and coverage are committed too (a current-season game log that gained box
// score links queues them). It must normalize to exactly the data under
// review; persistence then commits it and closes the issue in one transaction.
export async function acceptIssue({ persistence, rawStore, parsers, discovery, normalizer, clock, issueId, operatorId, reason }) {
  if (!isIssueId(issueId)) throw new Error(`issue id ${issueId} is invalid. Expected an id from the review list. Example: issue-12`);
  const issue = await persistence.getIssue(issueId);
  if (!issue) throw new Error(`issue ${issueId} does not exist`);
  if (issue.status !== 'open') throw new Error(`issue ${issueId} is already ${issue.status}`);
  if (issue.issueType !== 'conflicting_page_reprocess') throw new Error(`only a conflicting_page_reprocess issue can be accepted; dismiss a ${issue.issueType} issue instead`);
  const revision = issue.quarantinedRevision;
  if (!revision?.jobKey) throw new Error(`issue ${issueId} holds no quarantined revision to accept; dismiss it instead`);
  const job = await persistence.getJob(revision.jobKey);
  const fetch = await persistence.getSourceFetch(revision.sourceFetchId);
  if (!job || !fetch?.checksum) throw new Error(`the source fetch behind issue ${issueId} is missing`);
  const stored = await rawStore.read(fetch.checksum, fetch.objectPath);
  if (!stored.ok) throw new Error(`the stored snapshot behind issue ${issueId} failed verification: ${stored.reason}`);
  if (!parsers.has(job.pageType, revision.parserVersion)) {
    throw new Error(`accepting needs the parser that produced the revision, ${job.pageType}@${revision.parserVersion}, which is not registered`);
  }
  const snapshot = snapshotFor(job, stored.body);
  const { parsed, run } = parseSnapshot({ parsers, job, snapshot, parserVersion: revision.parserVersion, sourceFetchId: fetch.id, clock });
  if (parsed.kind !== 'valid') throw new Error(`the stored snapshot no longer parses: ${parsed.error}`);
  const { page, provenance } = normalizeParsedPage({ job, snapshot, parsed, run, discovery, normalizer, clock });
  if (differingPaths(page.data, issue.details.current.data).length) {
    throw new Error('the stored snapshot no longer normalizes to the revision under review (the parser or data contract changed); reprocess the job and review again');
  }
  return persistence.acceptRevision({ issueId, page, provenance, operatorId, reason, at: clock() });
}

function column(value, width) { return String(value ?? '').padEnd(width); }

// The review list as text for a terminal.
export function formatReviewList(list) {
  const lines = [`Jobs to review (${list.jobs.length}${list.nextJobCursor ? '+' : ''})`];
  for (const job of list.jobs) {
    lines.push(`  ${column(job.state, 14)} ${column(job.pageType, 15)} ${job.url}`);
    lines.push(`  ${column('', 14)} ${job.parser ? `${job.parser}: ` : ''}${job.reason ?? 'no reason recorded'}`);
    lines.push(`  ${column('', 14)} job: ${job.key}`);
  }
  if (!list.jobs.length) lines.push('  none');
  lines.push(`Open issues (${list.issues.length}${list.nextIssueCursor ? '+' : ''})`);
  for (const issue of list.issues) {
    const detail = issue.changed ? `changed: ${issue.changed.join(', ')}` : issue.field ? `${issue.field}: game log ${issue.gameLog}, box score ${issue.boxScore}` : '';
    lines.push(`  ${column(issue.id, 14)} ${column(issue.issueType, 27)} ${issue.recordKey}`);
    if (detail) lines.push(`  ${column('', 14)} ${detail}`);
  }
  if (!list.issues.length) lines.push('  none');
  lines.push('Details: npm run review -- show <job key | issue id>');
  return lines.join('\n');
}
