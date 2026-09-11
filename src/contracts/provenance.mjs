export function createProvenance({ providerId, canonicalPath, sourceUrl, sourceFetchId, parserName, parserVersion, parsedAt }) {
  if (!providerId || !canonicalPath || !sourceUrl || !sourceFetchId || !parserName || !parserVersion || !parsedAt) {
    throw new Error('incomplete provenance. Expected provider, canonical path, source URL, fetch ID, parser version, and parsed timestamp. Example: parserVersion: 1');
  }
  const parsedDate = new Date(parsedAt);
  if (Number.isNaN(parsedDate.getTime())) throw new Error(`invalid provenance timestamp: ${parsedAt}. Expected an ISO-8601 timestamp.`);
  return Object.freeze({
    providerId,
    canonicalPath,
    sourceUrl,
    sourceFetchId,
    parserName,
    parserVersion,
    parsedAt: parsedDate.toISOString(),
  });
}
