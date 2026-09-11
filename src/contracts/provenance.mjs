export function createProvenance({ providerId, canonicalPath, sourceUrl, sourceFetchId, parserName, parserVersion, parsedAt }) {
  if (!providerId || !canonicalPath || !sourceUrl || !sourceFetchId || !parserName || !parserVersion || !parsedAt) {
    throw new Error('incomplete provenance. Expected provider, canonical path, source URL, fetch ID, parser version, and parsed timestamp. Example: parserVersion: 1');
  }
  return Object.freeze({
    providerId,
    canonicalPath,
    sourceUrl,
    sourceFetchId,
    parserName,
    parserVersion,
    parsedAt: new Date(parsedAt).toISOString(),
  });
}
