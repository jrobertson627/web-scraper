import { assertPageType } from './source.mjs';

export const FETCH_RESULT_KINDS = Object.freeze([
  'fetched', 'not_modified', 'retry_wait', 'operator_stop', 'permanently_failed',
]);

export const PARSE_RESULT_KINDS = Object.freeze(['valid', 'structural_failure']);

export const BOUNDARY_PORT_METHODS = Object.freeze({
  fetcher: Object.freeze(['fetch']),
  discovery: Object.freeze(['discover']),
  parsers: Object.freeze(['get', 'parse']),
  domain: Object.freeze(['normalize']),
  persistence: Object.freeze(['claimNextJob', 'listJobs', 'getJob', 'transitionJob', 'recordParse', 'commitPage', 'commitPageAndTransition', 'recoverExpiredClaims']),
  api: Object.freeze(['listSchools', 'listSeasons', 'listGames', 'getGame', 'health']),
});

export function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value) || ArrayBuffer.isView(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

export function assertBoundaryPort(boundary, port) {
  const methods = BOUNDARY_PORT_METHODS[boundary];
  if (!methods) throw new Error(`unknown boundary port: ${boundary}`);
  if (!port || typeof port !== 'object') throw new Error(`${boundary} boundary port is missing`);
  for (const method of methods) {
    if (typeof port[method] !== 'function') throw new Error(`${boundary} boundary port is missing ${method}()`);
  }
  return port;
}

export function createJob(input) {
  if (!input?.key || !input.sourceUrl || !input.canonicalPath) {
    throw new Error('job contract requires key, sourceUrl, and canonicalPath');
  }
  assertPageType(input.pageType);
  return deepFreeze({ ...input });
}

export function createSnapshot(input) {
  if (!input?.jobKey || !input.sourceUrl || !Buffer.isBuffer(input.body) || typeof input.sourceUrlFrom !== 'function') {
    throw new Error('snapshot contract requires jobKey, sourceUrl, Buffer body, and sourceUrlFrom()');
  }
  return Object.freeze({ ...input, body: Buffer.from(input.body) });
}

export function createFetchResult(input) {
  if (!FETCH_RESULT_KINDS.includes(input?.kind)) throw new Error(`invalid fetch result kind: ${input?.kind}`);
  if (['fetched', 'not_modified'].includes(input.kind) && (!input.sourceFetchId || !input.checksum)) {
    throw new Error(`${input.kind} fetch result requires sourceFetchId and checksum`);
  }
  if (input.kind === 'retry_wait' && (!input.reason || !input.nextAllowedAt)) {
    throw new Error('retry_wait fetch result requires reason and nextAllowedAt');
  }
  if (['operator_stop', 'permanently_failed'].includes(input.kind) && !input.reason) {
    throw new Error(`${input.kind} fetch result requires reason`);
  }
  return deepFreeze({ ...input });
}

export function createDiscoveryResult({ observations = [], childJobs = [], unavailableCoverage = [], warnings = [] } = {}) {
  return deepFreeze({
    observations: [...observations],
    childJobs: childJobs.map(createJob),
    unavailableCoverage: [...unavailableCoverage],
    warnings: [...warnings],
  });
}

export function createParseResult(input) {
  if (!PARSE_RESULT_KINDS.includes(input?.kind)) throw new Error(`invalid parse result kind: ${input?.kind}`);
  if (input.kind === 'valid' && (!input.document || typeof input.document !== 'object')) throw new Error('valid parse result requires document');
  if (input.kind === 'structural_failure' && !input.error) throw new Error('structural_failure parse result requires error');
  if (input.warnings !== undefined && !Array.isArray(input.warnings)) throw new Error('parse result warnings must be an array');
  return deepFreeze({ warnings: [], ...input, warnings: [...(input.warnings ?? [])] });
}

export function createNormalizedPage(input) {
  if (!input?.jobKey || !input.kind || !input.identity || !input.data) {
    throw new Error('normalized page contract requires jobKey, kind, identity, and data');
  }
  return deepFreeze({
    observations: [],
    childJobs: [],
    unavailableCoverage: [],
    ...input,
    observations: [...(input.observations ?? [])],
    childJobs: [...(input.childJobs ?? [])],
    unavailableCoverage: [...(input.unavailableCoverage ?? [])],
  });
}

export function createQueryModels({ schools = [], seasons = [], games = [], health = {} } = {}) {
  return deepFreeze({ schools: [...schools], seasons: [...seasons], games: [...games], health: { ...health } });
}

export function createReconciliationIssue(input) {
  if (!input?.issueType || !input.recordKey || !input.details) {
    throw new Error('reconciliation issue requires issueType, recordKey, and details');
  }
  return deepFreeze({ status: 'open', ...input });
}
