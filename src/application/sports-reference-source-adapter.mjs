import { canonicalizeSourceUrl, createSourceUrl } from '../contracts/source.mjs';

// Production source adapter for Sports Reference men's college basketball (#36).
// It classifies only the five published URL shapes, refuses the paths that
// robots.txt disallows, and never builds a fetchable URL from a pattern: the
// only URL it creates is the fixed school index. See URL_IDENTITY.md.

export const SPORTS_REFERENCE_PROVIDER_ID = 'sports-reference';
export const SPORTS_REFERENCE_HOST = 'www.sports-reference.com';
const ORIGIN = `https://${SPORTS_REFERENCE_HOST}`;

// The /cbb/ Disallow rules of https://www.sports-reference.com/robots.txt as
// recorded in #36. The index.cgi rule is `/cbb/boxscores/index.cgi?*`; the
// adapter refuses the script with or without a query.
export const SPORTS_REFERENCE_DISALLOWED_PATHS = Object.freeze([
  '/cbb/boxscores/index.cgi', '/cbb/req/', '/cbb/short/', '/cbb/nocdn/',
]);

const SLUG = '[a-z0-9]+(?:-[a-z0-9]+)*';
const PAGE_PATTERNS = Object.freeze([
  ['school_index', /^\/cbb\/schools\/$/],
  ['school_history', new RegExp(`^/cbb/schools/${SLUG}/men/$`)],
  ['season', new RegExp(`^/cbb/schools/${SLUG}/men/\\d{4}\\.html$`)],
  ['game_log', new RegExp(`^/cbb/schools/${SLUG}/men/\\d{4}-gamelogs\\.html$`)],
  ['box_score', new RegExp(`^/cbb/boxscores/\\d{4}-\\d{2}-\\d{2}-\\d{2}-${SLUG}\\.html$`)],
]);
const SCHOOL_PAGE = new RegExp(`^(/cbb/schools/${SLUG}/men/)(?:\\d{4}(?:-gamelogs)?\\.html)?$`);

export function isRobotsDisallowed(path) {
  return SPORTS_REFERENCE_DISALLOWED_PATHS.some((prefix) => path.startsWith(prefix));
}

// Disallow rules in a robots.txt body (for any user agent) under /cbb/ that the
// adapter does not already refuse. Run before each bulk crawl; a non-empty
// result means robots.txt changed and the adapter must be updated first.
export function unrefusedRobotsRules(robotsTxt) {
  const rules = String(robotsTxt).split(/\r?\n/)
    .map((line) => /^\s*disallow\s*:\s*(\S+)/i.exec(line.replace(/#.*/, ''))?.[1])
    .filter((rule) => rule?.startsWith('/cbb/'));
  // A wildcard rule is compared by its literal prefix, so `/cbb/*` is reported.
  return [...new Set(rules)].filter((rule) => !isRobotsDisallowed(rule.replace(/[*$].*$/, '').replace(/\?$/, '')));
}

function refuse(sourceUrl, reason) {
  return new Error(`Sports Reference adapter refused ${sourceUrl?.absoluteUrl ?? sourceUrl}: ${reason}`);
}

export class SportsReferenceSourceAdapter {
  providerId() { return SPORTS_REFERENCE_PROVIDER_ID; }
  indexUrl() { return createSourceUrl(SPORTS_REFERENCE_PROVIDER_ID, `${ORIGIN}/cbb/schools/`); }

  // What in a robots.txt body the crawler does not honour: a Disallow rule under
  // /cbb/ that this adapter does not refuse (#131). The worker checks it while it runs.
  robotsProblems(robotsTxt) {
    return unrefusedRobotsRules(robotsTxt).map((rule) => `disallows ${rule}, which the crawler does not refuse`);
  }

  // Returns the validated URL's path, or throws when it is off-provider,
  // robots-disallowed, or carries a query the published pages never use.
  #checkedPath(sourceUrl) {
    if (sourceUrl?.providerId !== SPORTS_REFERENCE_PROVIDER_ID) throw refuse(sourceUrl, `provider is ${sourceUrl?.providerId}, expected ${SPORTS_REFERENCE_PROVIDER_ID}`);
    const url = new URL(createSourceUrl(sourceUrl.providerId, sourceUrl.absoluteUrl).absoluteUrl);
    if (url.host.toLowerCase() !== SPORTS_REFERENCE_HOST) throw refuse(sourceUrl, `host is ${url.host}, expected ${SPORTS_REFERENCE_HOST}`);
    if (isRobotsDisallowed(url.pathname)) throw refuse(sourceUrl, 'robots.txt disallows this path');
    if (url.search) throw refuse(sourceUrl, 'published page URLs have no query string');
    return url.pathname;
  }

  classify(sourceUrl) {
    const path = this.#checkedPath(sourceUrl);
    const match = PAGE_PATTERNS.find(([, pattern]) => pattern.test(path));
    if (!match) throw refuse(sourceUrl, 'path is not a school index, school history, season, game log, or box score page');
    return match[0];
  }

  canonicalize(sourceUrl) {
    this.classify(sourceUrl);
    return canonicalizeSourceUrl(sourceUrl);
  }

  // A school's identity is its men's history path. Opponent links point at the
  // opponent's season page; dropping `<year>.html` gives the school path. The
  // result identifies the school only and is never queued for crawling.
  schoolUrl(sourceUrl) {
    const path = this.#checkedPath(sourceUrl);
    const school = SCHOOL_PAGE.exec(path)?.[1];
    if (!school) throw refuse(sourceUrl, 'path is not a school history, season, or game log page');
    return createSourceUrl(SPORTS_REFERENCE_PROVIDER_ID, `${ORIGIN}${school}`);
  }
}
