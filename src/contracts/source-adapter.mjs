import { assertPageType } from './source.mjs';

const REQUIRED_METHODS = Object.freeze(['providerId', 'indexUrl', 'classify', 'canonicalize']);

export function assertSourceAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object') {
    throw new Error('source adapter is missing. Expected an object implementing providerId, indexUrl, classify, and canonicalize.');
  }
  for (const method of REQUIRED_METHODS) {
    if (typeof adapter[method] !== 'function') {
      throw new Error(`source adapter method ${method} is missing. Expected providerId, indexUrl, classify, and canonicalize.`);
    }
  }

  const providerId = adapter.providerId();
  if (typeof providerId !== 'string' || !providerId) throw new Error('source adapter providerId must be a non-empty string.');
  const indexUrl = adapter.indexUrl();
  if (indexUrl?.providerId !== providerId) throw new Error('source adapter indexUrl provider does not match providerId.');
  assertPageType(adapter.classify(indexUrl));
  const canonicalPath = adapter.canonicalize(indexUrl);
  if (canonicalPath?.providerId !== providerId) throw new Error('source adapter canonical path provider does not match providerId.');
  return adapter;
}
