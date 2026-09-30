import { createSnapshot } from '../contracts/boundaries.mjs';
import { createProvenance } from '../contracts/provenance.mjs';
import { createSourceUrl } from '../contracts/source.mjs';

// The steps from a stored body to a normalized page, shared by the worker
// (orchestrator.mjs) and offline reprocessing (reprocess.mjs). None of them
// touches transport or persistence.

// finalUrl is where the fetch ended after redirects (#124), when that is not the
// queued URL. The page's own identity stays the job's, but its relative links
// are resolved against where the body was actually served from.
export function snapshotFor(job, body, { finalUrl } = {}) {
  const baseUrl = finalUrl ?? job.sourceUrl.absoluteUrl;
  return createSnapshot({
    jobKey: job.key,
    parentKey: job.parentKey,
    schoolSourcePath: job.schoolSourcePath,
    sourceUrl: job.sourceUrl,
    baseUrl,
    body,
    sourceUrlFrom: (target, base = baseUrl) => createSourceUrl(job.sourceUrl.providerId, target, base),
  });
}

// The configured parser version for the job's page type, else the version the
// job was queued with. A configured upgrade therefore applies to every job,
// including those queued before it.
export function parserVersionFor(job, parserVersions) {
  return parserVersions?.[job.pageType] ?? job.parserVersion ?? '1';
}

// Parses the snapshot and describes the parse run to record.
export function parseSnapshot({ parsers, job, snapshot, parserVersion, sourceFetchId, clock }) {
  const parser = parsers.get(job.pageType, parserVersion);
  const parsed = parsers.parse(job.pageType, parserVersion, snapshot);
  const run = {
    jobKey: job.key,
    sourceFetchId,
    parserName: job.pageType,
    parserVersion: parser.version(),
    status: parsed.kind,
    warnings: parsed.warnings ?? [],
    failureDetails: parsed.kind === 'structural_failure' ? { error: parsed.error } : null,
    parsedAt: clock().toISOString(),
  };
  return { parsed, run };
}

// Discovers and normalizes a valid parse, with the provenance of its run.
export function normalizeParsedPage({ job, snapshot, parsed, run, discovery, normalizer, clock }) {
  const discovered = discovery.discover(job.pageType, snapshot, parsed.document);
  const page = normalizer.normalize(job.pageType, parsed.document, {
    jobKey: job.key,
    canonicalPath: job.canonicalPath,
    observations: discovered.observations,
    childJobs: discovered.childJobs,
    unavailableCoverage: discovered.unavailableCoverage,
  });
  const provenance = createProvenance({
    providerId: job.sourceUrl.providerId,
    canonicalPath: job.canonicalPath,
    sourceUrl: job.sourceUrl,
    sourceFetchId: run.sourceFetchId,
    parserName: run.parserName,
    parserVersion: run.parserVersion,
    parsedAt: clock().toISOString(),
  });
  return { discovered, page, provenance };
}
