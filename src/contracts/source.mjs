export const PAGE_TYPES = Object.freeze([
  'school_index',
  'school_history',
  'season',
  'game_log',
  'box_score',
]);

export const TARGET_ENDING_YEARS = Object.freeze([2022, 2023, 2024, 2025, 2026]);
export const REQUIRED_ELIGIBILITY_ENDING_YEAR = 2026;
export const REQUIRED_ELIGIBILITY_PREDICATE = `To == ${REQUIRED_ELIGIBILITY_ENDING_YEAR}`;

export function isEligibleSchool(school) {
  return school?.to === REQUIRED_ELIGIBILITY_ENDING_YEAR;
}

export function assertPageType(pageType) {
  if (!PAGE_TYPES.includes(pageType)) {
    throw new Error(`invalid page type: ${pageType}. Expected one of ${PAGE_TYPES.join(', ')}. Example: pageType: season`);
  }
  return pageType;
}

export function createSourceUrl(providerId, targetUrl, baseUrl) {
  let url;
  try {
    url = new URL(targetUrl, baseUrl);
  } catch (error) {
    throw new Error(`invalid source URL: ${targetUrl}. Expected an absolute or base-resolvable HTTPS URL.`, { cause: error });
  }
  if (url.protocol !== 'https:') {
    throw new Error(`invalid source URL scheme: ${url.protocol}. Expected https. Example: https://provider.example/cbb/schools/`);
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
  return sourceUrl?.absoluteUrl.startsWith('https://') &&
    allowedHosts.map((host) => host.toLowerCase()).includes(sourceUrl.host.toLowerCase());
}

export function canonicalizeSourceUrl(sourceUrl) {
  const url = new URL(sourceUrl.absoluteUrl);
  const normalizedPath = url.pathname.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
  const normalizedQuery = new URLSearchParams(url.search);
  normalizedQuery.sort();
  return Object.freeze({
    providerId: sourceUrl.providerId,
    host: url.host.toLowerCase(),
    path: normalizedPath,
    normalizedQuery: normalizedQuery.toString(),
  });
}

