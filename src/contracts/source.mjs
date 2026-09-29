export const PAGE_TYPES = Object.freeze([
  'school_index',
  'school_history',
  'season',
  'game_log',
  'box_score',
]);


// About 360 schools are eligible in a normal season (the index lists about 365
// with To == 2026). An index that yields far fewer means the eligibility rule no
// longer matches the site, for example after it added a new season, and must not
// pass as a successful, empty crawl (#115).
export const EXPECTED_ELIGIBLE_SCHOOLS = 360;
export const MIN_ELIGIBLE_SCHOOLS = 300;

// A school is eligible when its To is the current season's ending year (season.mjs).
export function isEligibleSchool(school, seasonEndingYear) {
  return school?.to === seasonEndingYear;
}

export function assertPageType(pageType) {
  if (!PAGE_TYPES.includes(pageType)) {
    throw new Error(`invalid page type: ${pageType}. Expected one of ${PAGE_TYPES.join(', ')}. Example: pageType: season`);
  }
  return pageType;
}

export function createSourceUrl(providerId, targetUrl, baseUrl) {
  if (typeof providerId !== 'string' || !providerId.trim()) {
    throw new Error('invalid provider id. Expected a non-empty provider identifier. Example: providerId: sports-reference');
  }
  let url;
  try {
    url = new URL(targetUrl, baseUrl);
  } catch (error) {
    throw new Error(`invalid source URL: ${targetUrl}. Expected an absolute or base-resolvable HTTPS URL.`, { cause: error });
  }
  if (url.protocol !== 'https:') {
    throw new Error(`invalid source URL scheme: ${url.protocol}. Expected https. Example: https://provider.example/cbb/schools/`);
  }
  if (url.username || url.password) {
    throw new Error('invalid source URL credentials. Expected an HTTPS URL without username or password.');
  }
  if (url.hash) {
    throw new Error('invalid source URL fragment. Expected a fetchable URL without a #fragment.');
  }
  return Object.freeze({
    providerId,
    absoluteUrl: url.href,
    host: url.host.toLowerCase(),
    path: url.pathname || '/',
    query: url.search,
  });
}

export function canonicalPathString(canonicalPath) {
  return `${canonicalPath.host}${canonicalPath.path}${canonicalPath.normalizedQuery ? `?${canonicalPath.normalizedQuery}` : ''}`;
}

export function serializeCanonicalPath(canonicalPath) {
  return `${canonicalPath.providerId}:${canonicalPathString(canonicalPath)}`;
}

export function sourceKey(canonicalPath, pageType) {
  assertPageType(pageType);
  return `${serializeCanonicalPath(canonicalPath)}:${pageType}`;
}

export function gameKey(canonicalPath) {
  return serializeCanonicalPath(canonicalPath);
}

export function isAllowedSourceUrl(sourceUrl, allowedHosts) {
  if (!sourceUrl || typeof sourceUrl.absoluteUrl !== 'string' || !Array.isArray(allowedHosts)) return false;
  let url;
  try { url = new URL(sourceUrl.absoluteUrl); } catch { return false; }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) return false;
  const allowed = new Set(allowedHosts.filter((host) => typeof host === 'string').map((host) => host.toLowerCase()));
  return allowed.has(url.host.toLowerCase());
}

export function canonicalizeSourceUrl(sourceUrl) {
  const validated = createSourceUrl(sourceUrl?.providerId, sourceUrl?.absoluteUrl);
  const url = new URL(validated.absoluteUrl);
  const normalizedPath = url.pathname.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
  const queryEntries = [...new URLSearchParams(url.search).entries()]
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue));
  const normalizedQuery = new URLSearchParams(queryEntries).toString();
  return Object.freeze({
    providerId: validated.providerId,
    host: url.host.toLowerCase(),
    path: normalizedPath,
    normalizedQuery,
  });
}
