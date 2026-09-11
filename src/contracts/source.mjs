export const PAGE_TYPES = Object.freeze([
  'school_index',
  'school_history',
  'season',
  'game_log',
  'box_score',
]);

export const TARGET_ENDING_YEARS = Object.freeze([2022, 2023, 2024, 2025, 2026]);
export const REQUIRED_ELIGIBILITY_PREDICATE = 'To == 2026';

export function assertPageType(pageType) {
  if (!PAGE_TYPES.includes(pageType)) {
    throw new Error(`invalid page type: ${pageType}. Expected one of ${PAGE_TYPES.join(', ')}. Example: pageType: season`);
  }
  return pageType;
}

export function createSourceUrl(providerId, absoluteUrl) {
  const url = new URL(absoluteUrl);
  if (url.protocol !== 'https:') {
    throw new Error(`invalid source URL scheme: ${url.protocol}. Expected https. Example: https://provider.example/cbb/schools/`);
  }
  return Object.freeze({
    providerId,
    absoluteUrl: url.href,
    host: url.host,
    path: url.pathname || '/',
    query: url.search,
  });
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

export function sourceKey(canonicalPath, pageType) {
  assertPageType(pageType);
  return `${canonicalPath.providerId}:${canonicalPath.host}${canonicalPath.path}?${canonicalPath.normalizedQuery}:${pageType}`;
}

export function gameKey(canonicalPath) {
  return `${canonicalPath.providerId}:${canonicalPath.host}${canonicalPath.path}?${canonicalPath.normalizedQuery}`;
}

export function isAllowedSourceUrl(sourceUrl, allowedHosts) {
  return sourceUrl.absoluteUrl.startsWith('https://') && allowedHosts.includes(sourceUrl.host.toLowerCase());
}
