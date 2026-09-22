import { REQUIRED_ELIGIBILITY_PREDICATE, TARGET_ENDING_YEARS } from '../contracts/source.mjs';
import { PAGE_TYPES } from '../contracts/source.mjs';
import { validateRequestPolicy } from '../contracts/request-policy.mjs';
import { requireAuthorization } from './authorization.mjs';
import { contractFingerprint, requireDataContract } from './data-contract.mjs';
import { isAbsolute } from 'node:path';

function configError(field, problem, expected, example) {
  return new Error(`${field} ${problem}. ${expected}. Example: ${example}`);
}

export function validateConfiguration(input, { clock = () => new Date() } = {}) {
  const config = structuredClone(input);
  if (!['local', 'worker', 'api'].includes(config.mode)) {
    throw configError('mode', `is invalid: ${config.mode}`, 'Expected local, worker, or api', 'mode: local');
  }
  config.policy = validateRequestPolicy(config.policy);
  if (!Array.isArray(config.allowedHosts) || config.allowedHosts.length === 0 ||
      config.allowedHosts.some((host) => typeof host !== 'string' || !/^[a-z0-9.-]+$/i.test(host) || host.startsWith('.') || host.endsWith('.') || host.includes('..'))) {
    throw configError('allowedHosts', 'is invalid', 'Expected host names without schemes, paths, or ports', 'allowedHosts: [provider.example]');
  }
  if (typeof config.providerId !== 'string' || !config.providerId) {
    throw configError('providerId', 'is missing', 'Expected a non-empty provider identifier', 'providerId: provider');
  }
  if (config.eligibilityPredicate !== REQUIRED_ELIGIBILITY_PREDICATE) {
    throw configError('eligibilityPredicate', `is invalid: ${config.eligibilityPredicate}`, `Expected exactly ${REQUIRED_ELIGIBILITY_PREDICATE}`, `eligibilityPredicate: '${REQUIRED_ELIGIBILITY_PREDICATE}'`);
  }
  const years = [...(config.targetEndingYears ?? [])].sort((a, b) => a - b);
  if (JSON.stringify(years) !== JSON.stringify(TARGET_ENDING_YEARS)) {
    throw configError('targetEndingYears', `is invalid: ${JSON.stringify(config.targetEndingYears)}`, `Expected exactly ${JSON.stringify(TARGET_ENDING_YEARS)}`, 'targetEndingYears: [2022, 2023, 2024, 2025, 2026]');
  }
  if (!['memory', 'filesystem'].includes(config.rawStore)) {
    throw configError('rawStore', `is invalid: ${config.rawStore}`, 'Expected memory or filesystem', 'rawStore: memory');
  }
  if (config.rawStore === 'filesystem' && (typeof config.rawStoreRoot !== 'string' || !isAbsolute(config.rawStoreRoot))) {
    throw configError('rawStoreRoot', 'is invalid', 'Expected an absolute filesystem path', 'rawStoreRoot: /var/lib/web-scraper/raw');
  }
  if (config.requestMethod !== undefined && config.requestMethod !== 'GET') throw configError('requestMethod', 'must be GET', 'Expected GET-only transport', 'requestMethod: GET');
  if (config.redirectMode !== undefined && config.redirectMode !== 'manual') throw configError('redirectMode', 'must be manual', 'Expected per-hop allowlist checks', 'redirectMode: manual');
  if (config.allowedSchemes !== undefined && JSON.stringify(config.allowedSchemes) !== JSON.stringify(['https'])) throw configError('allowedSchemes', 'must contain only https', 'Expected exactly [https]', 'allowedSchemes: [https]');
  config.requestMethod = 'GET';
  config.redirectMode = 'manual';
  config.allowedSchemes = ['https'];
  if (config.claimTimeoutMs === undefined) config.claimTimeoutMs = 30_000;
  if (!Number.isSafeInteger(config.claimTimeoutMs) || config.claimTimeoutMs < 10_000 || config.claimTimeoutMs > 300_000) throw configError('claimTimeoutMs', 'is invalid', 'Expected an integer from 10000 through 300000 milliseconds', 'claimTimeoutMs: 30000');
  if (config.parserVersions === undefined) config.parserVersions = Object.fromEntries(PAGE_TYPES.map((pageType) => [pageType, '1']));
  if (!config.parserVersions || typeof config.parserVersions !== 'object' || Array.isArray(config.parserVersions) ||
      Object.keys(config.parserVersions).some((pageType) => !PAGE_TYPES.includes(pageType)) ||
      PAGE_TYPES.some((pageType) => typeof config.parserVersions[pageType] !== 'string' || !config.parserVersions[pageType].trim())) {
    throw configError('parserVersions', 'is invalid', 'Expected a non-empty version for every page type', "parserVersions: { school_index: '1', school_history: '1', season: '1', game_log: '1', box_score: '1' }");
  }
  if (config.mode === 'local' && config.publication === 'public') {
    throw configError('publication', 'cannot be public in local mode', 'Expected private fixture output', 'publication: private');
  }
  const expectedScope = { allowedHosts: config.allowedHosts, eligibilityPredicate: config.eligibilityPredicate, targetEndingYears: years };
  const requiresUpstream = config.mode === 'worker' || (config.mode === 'api' && config.publication === 'public');
  if (requiresUpstream) {
    const use = config.mode === 'worker' ? 'crawl' : 'publish';
    if (!config.authorization) requireAuthorization(config.authorization, config.providerId, use, clock);
    const contract = requireDataContract(config.dataContract, config.providerId, clock, config.dataContract?.version);
    if (use === 'publish' && contract.redistribution !== 'public') throw configError('dataContract.redistribution', 'must permit public redistribution', 'Expected public', 'redistribution: public');
    requireAuthorization(config.authorization, config.providerId, use, clock, { expectedScope, expectedContractVersion: contract.version, expectedContractFingerprint: contractFingerprint(contract) });
  }
  return deepFreeze(config);
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
