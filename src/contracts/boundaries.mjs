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
  // The keyed, paged reads the query service is built on; see BOUNDARY_CONTRACTS.md.
  persistenceReads: Object.freeze(['listSchools', 'listSeasons', 'listGames', 'getGame', 'health']),
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

export const DEFAULT_PAGE_LIMIT = 100;
export const MAX_PAGE_LIMIT = 500;
const MAX_CURSOR_LENGTH = 2048;

function pagingError(message) {
  return Object.assign(new Error(message), { code: 'invalid_paging' });
}

// A list read takes { limit, cursor } and returns { items, nextCursor }. The
// cursor is opaque to callers: each adapter encodes the sort key of the last
// row it returned and resumes strictly after it (keyset paging), so a page
// costs the same however deep it is.
export function createPageRequest({ limit, cursor } = {}) {
  const size = limit === undefined || limit === null || limit === '' ? DEFAULT_PAGE_LIMIT : Number(limit);
  if (!Number.isInteger(size) || size < 1 || size > MAX_PAGE_LIMIT) {
    throw pagingError(`limit is invalid. Expected an integer from 1 through ${MAX_PAGE_LIMIT}. Example: limit=${DEFAULT_PAGE_LIMIT}`);
  }
  if (cursor !== undefined && cursor !== null && (typeof cursor !== 'string' || !cursor || cursor.length > MAX_CURSOR_LENGTH)) {
    throw pagingError('cursor is invalid. Expected the nextCursor value from the previous page');
  }
  return Object.freeze({ limit: size, cursor: cursor || null });
}

export function encodePageCursor(key) {
  return Buffer.from(JSON.stringify(key)).toString('base64url');
}

// shape lists the key parts' types, for example ['string', 'integer'].
export function decodePageCursor(cursor, shape) {
  if (!cursor) return null;
  let key;
  try { key = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { key = null; }
  const fits = (part, type) => (type === 'integer' ? Number.isSafeInteger(part) : typeof part === 'string');
  if (!Array.isArray(key) || key.length !== shape.length || !key.every((part, index) => fits(part, shape[index]))) {
    throw pagingError('cursor is invalid. Expected the nextCursor value from the previous page');
  }
  return key;
}

// rows holds up to limit + 1 source rows in key order; the extra row only
// signals that another page exists. keyOf reads a row's sort key and toItem
// maps it to the consumer-facing model.
export function createReadPage(rows, limit, keyOf, toItem = (row) => row) {
  const kept = rows.slice(0, limit);
  const nextCursor = rows.length > limit && kept.length ? encodePageCursor(keyOf(kept.at(-1))) : null;
  return deepFreeze({ items: kept.map(toItem), nextCursor });
}

export function createReconciliationIssue(input) {
  if (!input?.issueType || !input.recordKey || !input.details) {
    throw new Error('reconciliation issue requires issueType, recordKey, and details');
  }
  return deepFreeze({ status: 'open', ...input });
}
