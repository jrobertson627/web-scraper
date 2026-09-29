import { deepFreeze } from './boundaries.mjs';
import { PAGE_TYPES, TARGET_ENDING_YEARS } from './source.mjs';

// What a crawl covers (#78; see "Decision: crawl scope" in REQUEST_POLICY.md).
// The full scope is the project's fixed contract: every school whose index row
// has To == 2026, and each one's linked seasons ending in 2022-2026. A sample
// restricts it to named schools and some of those years, never wider, so the
// full-scope checks stay exactly as they are. The scope a store was crawled
// under is recorded with it, and may only widen.

export const FULL_CRAWL_SCOPE = deepFreeze({ kind: 'full', schools: null, endingYears: [...TARGET_ENDING_YEARS] });

const MAX_SAMPLE_SCHOOLS = 50;
// A site path such as /cbb/schools/duke/men/: no scheme, host, query or fragment.
const SITE_PATH = /^\/(?:[A-Za-z0-9._~-]+\/)*[A-Za-z0-9._~-]*$/;

function scopeError(problem) {
  return new Error(`crawl sample ${problem}. Example: {"schools":["/cbb/schools/duke/men/"],"endingYears":[2024]}`);
}

// undefined or { kind: 'full' } is the full scope; { schools, endingYears }
// (kind 'sample' optional) is a sample.
export function createCrawlScope(input) {
  if (input === undefined || input === null) return FULL_CRAWL_SCOPE;
  if (typeof input !== 'object' || Array.isArray(input)) throw scopeError('is invalid: expected an object of schools and endingYears');
  if (input.kind === 'full') return FULL_CRAWL_SCOPE;
  if (input.kind !== undefined && input.kind !== 'sample') throw scopeError(`kind ${input.kind} is invalid: expected sample or full`);
  const extra = Object.keys(input).filter((key) => !['kind', 'schools', 'endingYears'].includes(key));
  if (extra.length) throw scopeError(`has unknown fields ${extra.join(', ')}`);
  const { schools, endingYears } = input;
  if (!Array.isArray(schools) || !schools.length || schools.length > MAX_SAMPLE_SCHOOLS) {
    throw scopeError(`schools must list from 1 to ${MAX_SAMPLE_SCHOOLS} school page paths`);
  }
  if (schools.some((path) => typeof path !== 'string' || !SITE_PATH.test(path) || path.split('/').includes('..'))) {
    throw scopeError('schools must be site paths of school pages, without host, query or fragment');
  }
  if (new Set(schools).size !== schools.length) throw scopeError('schools repeat a path');
  if (!Array.isArray(endingYears) || !endingYears.length || endingYears.some((year) => !TARGET_ENDING_YEARS.includes(year))
      || new Set(endingYears).size !== endingYears.length) {
    throw scopeError(`endingYears must be distinct years from ${TARGET_ENDING_YEARS.join(', ')}`);
  }
  return deepFreeze({ kind: 'sample', schools: [...schools].sort(), endingYears: [...endingYears].sort((a, b) => a - b) });
}

// Whether `wider` covers everything `narrower` does.
export function scopeCovers(wider, narrower) {
  if (wider.kind === 'full') return true;
  if (narrower.kind === 'full') return false;
  return narrower.schools.every((school) => wider.schools.includes(school))
    && narrower.endingYears.every((year) => wider.endingYears.includes(year));
}

export function sameScope(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function describeScope(scope) {
  return scope.kind === 'full' ? 'the full scope'
    : `a sample of ${scope.schools.length} school${scope.schools.length === 1 ? '' : 's'} (${scope.schools.join(', ')}), ending years ${scope.endingYears.join(', ')}`;
}

// The persistence adapters' rule for recording a scope: a store keeps the
// scopes it was crawled under, and a new one must cover the latest.
export function nextCrawlScope(previous, scope) {
  const next = createCrawlScope(scope);
  if (previous && !scopeCovers(next, previous)) {
    throw new Error(`crawl scope refused: this store was crawled under ${describeScope(previous)}, which ${describeScope(next)} does not cover. A scope may only widen.`);
  }
  return { scope: next, changed: !previous || !sameScope(previous, next), widened: Boolean(previous) && !sameScope(previous, next) };
}

// How deep a run goes (#44). The manifest stage fetches only the school index
// and history pages: enough to count eligible schools, linked target seasons
// and unavailable ones, without a season, game-log or box-score request. The
// season jobs it queues stay pending, so a later full run continues from them.
export const CRAWL_STAGES = Object.freeze({
  full: Object.freeze([...PAGE_TYPES]),
  manifest: Object.freeze(['school_index', 'school_history']),
});

export function assertCrawlStage(stage = 'full') {
  if (!Object.hasOwn(CRAWL_STAGES, stage)) throw new Error(`crawl stage ${stage} is invalid. Expected full or manifest. Example: CRAWL_STAGE=manifest`);
  return stage;
}
