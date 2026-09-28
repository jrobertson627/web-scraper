import { assertBoundaryPort } from '../contracts/boundaries.mjs';
import { REPROCESS_STATES } from '../contracts/jobs.mjs';
import { PAGE_TYPES } from '../contracts/source.mjs';
import { NO_CRAWL_EVENTS } from './crawl-log.mjs';
import { normalizeParsedPage, parseSnapshot, parserVersionFor, snapshotFor } from './page-pipeline.mjs';

const EXAMPLE_LIMIT = 20;

// Offline reprocessing (#43): parses settled jobs' stored raw snapshots again
// with the configured parser versions and commits the results. It is given no
// fetcher or transport, so it cannot make an upstream request.
//
// Selection: jobKeys, or every job in `states` (parsed and parse_failed by
// default) of `pageTypes` (all by default). For each job the latest stored
// snapshot is read and verified, parsed, discovered and normalized as the
// worker does, and persistence.commitReprocess records the parse run and
// commits the page. Whether the page replaces the accepted record follows the
// rule in PARSER_NORMALIZATION.md: a parser change over the same raw body
// supersedes it; a different body is held as a conflict for review. A
// parse_failed job whose page is accepted becomes parsed, and its child jobs
// are queued for the worker.
export async function reprocessStoredPages({
  persistence, rawStore, parsers, discovery, normalizer, clock, parserVersions,
  pageTypes = PAGE_TYPES, states = REPROCESS_STATES, jobKeys, pageSize = 100, events = NO_CRAWL_EVENTS,
}) {
  assertBoundaryPort('persistenceReprocess', persistence);
  const summary = {
    selected: 0, accepted: 0, superseded: 0, conflicts: 0, parseFailures: 0, promotedToParsed: 0, skipped: 0,
    parserVersions: {}, examples: { conflicts: [], parseFailures: [], skipped: [] },
  };
  const note = (list, entry) => { if (summary.examples[list].length < EXAMPLE_LIMIT) summary.examples[list].push(entry); };

  for await (const job of selectedJobs({ persistence, pageTypes, states, jobKeys, pageSize })) {
    summary.selected += 1;
    const outcome = await reprocessJob({ job, persistence, rawStore, parsers, discovery, normalizer, clock, parserVersions });
    if (outcome.parserVersion) {
      summary.parserVersions[job.pageType] ??= {};
      summary.parserVersions[job.pageType][outcome.parserVersion] = (summary.parserVersions[job.pageType][outcome.parserVersion] ?? 0) + 1;
    }
    if (outcome.kind === 'skipped') { summary.skipped += 1; note('skipped', { jobKey: job.key, reason: outcome.reason }); }
    if (outcome.kind === 'parse_failed') { summary.parseFailures += 1; note('parseFailures', { jobKey: job.key, reason: outcome.reason }); }
    if (outcome.kind === 'conflict') { summary.conflicts += 1; note('conflicts', { jobKey: job.key, recordKey: outcome.key }); }
    if (outcome.kind === 'accepted') summary.accepted += 1;
    if (outcome.superseded) summary.superseded += 1;
    if (outcome.transitioned) summary.promotedToParsed += 1;
    events.emit('page.reprocessed', { jobKey: job.key, pageType: job.pageType, kind: outcome.kind, parserVersion: outcome.parserVersion,
      superseded: outcome.superseded, transitioned: outcome.transitioned, reason: outcome.reason });
  }
  const result = Object.freeze(summary);
  events.emit('reprocess.completed', { selected: result.selected, accepted: result.accepted, superseded: result.superseded,
    conflicts: result.conflicts, parseFailures: result.parseFailures, promotedToParsed: result.promotedToParsed, skipped: result.skipped });
  return result;
}

async function* selectedJobs({ persistence, pageTypes, states, jobKeys, pageSize }) {
  if (jobKeys) {
    for (const key of jobKeys) {
      const job = await persistence.getJob(key);
      if (!job) throw new Error(`reprocess job is not queued: ${key}`);
      yield job;
    }
    return;
  }
  let cursor = null;
  do {
    const page = await persistence.listJobsForReprocess({ pageTypes, states, limit: pageSize, cursor });
    for (const job of page.items) yield job;
    cursor = page.nextCursor;
  } while (cursor);
}

async function reprocessJob({ job, persistence, rawStore, parsers, discovery, normalizer, clock, parserVersions }) {
  if (!REPROCESS_STATES.includes(job.state)) return { kind: 'skipped', reason: `job is ${job.state}, not parsed or parse_failed` };
  const fetch = await persistence.lastSuccessfulFetch(job.key);
  if (!fetch) return { kind: 'skipped', reason: 'no stored snapshot' };
  const stored = await rawStore.read(fetch.checksum, fetch.objectPath);
  if (!stored.ok) return { kind: 'skipped', reason: `stored snapshot failed verification: ${stored.reason}` };
  const snapshot = snapshotFor(job, stored.body);
  const { parsed, run } = parseSnapshot({
    parsers, job, snapshot, parserVersion: parserVersionFor(job, parserVersions), sourceFetchId: fetch.id, clock,
  });
  if (parsed.kind === 'structural_failure') {
    await persistence.commitReprocess({ jobKey: job.key, parseRun: run });
    return { kind: 'parse_failed', parserVersion: run.parserVersion, reason: parsed.error };
  }
  let normalized;
  try {
    normalized = normalizeParsedPage({ job, snapshot, parsed, run, discovery, normalizer, clock });
  } catch (error) {
    // The worker records such a page as parse_failed; here the run is kept as
    // a structural failure and the job's state is left as it is.
    const failed = { ...run, status: 'structural_failure', failureDetails: { error: error.message, phase: 'normalize' } };
    await persistence.commitReprocess({ jobKey: job.key, parseRun: failed });
    return { kind: 'parse_failed', parserVersion: run.parserVersion, reason: error.message };
  }
  const committed = await persistence.commitReprocess({
    jobKey: job.key, parseRun: run, page: normalized.page, provenance: normalized.provenance,
  });
  return {
    kind: committed.conflict ? 'conflict' : 'accepted', key: committed.key, parserVersion: run.parserVersion,
    superseded: Boolean(committed.superseded), transitioned: Boolean(committed.transitioned),
  };
}
