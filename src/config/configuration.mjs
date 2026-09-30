import { ELIGIBILITY_RULE, TARGET_YEARS_RULE, assertSeasonEndingYear, seasonEndingYearAt, targetEndingYearsFor } from '../contracts/season.mjs';
import { PAGE_TYPES } from '../contracts/source.mjs';
import { validateRequestPolicy } from '../contracts/request-policy.mjs';
import { requireAuthorization } from './authorization.mjs';
import { assertCrawlStage, createCrawlScope } from '../contracts/crawl-scope.mjs';
import { contractFingerprint, requireDataContract } from './data-contract.mjs';
import { isAbsolute } from 'node:path';

function configError(field, problem, expected, example) {
  return new Error(`${field} ${problem}. ${expected}. Example: ${example}`);
}

export function validateConfiguration(input, { clock = () => new Date() } = {}) {
  const config = structuredClone(input);
  if (!['local', 'worker', 'api'].includes(config.mode)) {
    throw configError('mode', 'is invalid', 'Expected local, worker, or api', 'mode: local');
  }
  config.policy = validateRequestPolicy(config.policy);
  if (!Array.isArray(config.allowedHosts) || config.allowedHosts.length === 0 ||
      config.allowedHosts.some((host) => typeof host !== 'string' || !/^[a-z0-9.-]+$/i.test(host) || host.startsWith('.') || host.endsWith('.') || host.includes('..'))) {
    throw configError('allowedHosts', 'is invalid', 'Expected host names without schemes, paths, or ports', 'allowedHosts: [provider.example]');
  }
  if (typeof config.providerId !== 'string' || !config.providerId) {
    throw configError('providerId', 'is missing', 'Expected a non-empty provider identifier', 'providerId: provider');
  }
  if (config.eligibilityPredicate !== ELIGIBILITY_RULE) {
    throw configError('eligibilityPredicate', 'is invalid', `Expected exactly ${ELIGIBILITY_RULE}`, `eligibilityPredicate: '${ELIGIBILITY_RULE}'`);
  }
  // The season is the one a crawl provisionally runs under: the year given
  // (CURRENT_SEASON_ENDING_YEAR, which is pinned) or else the season now. A worker
  // resolves the final one when it starts, from the school index's fetch time
  // (#115), so a pinned year always wins there.
  let seasonEndingYear;
  try {
    seasonEndingYear = config.currentSeasonEndingYear === undefined ? seasonEndingYearAt(clock()) : assertSeasonEndingYear(config.currentSeasonEndingYear);
  } catch {
    throw configError('currentSeasonEndingYear', 'is invalid', 'Expected a four-digit year', 'currentSeasonEndingYear: 2026');
  }
  const window = targetEndingYearsFor(seasonEndingYear);
  const years = config.targetEndingYears === undefined ? [...window] : [...config.targetEndingYears].sort((a, b) => a - b);
  if (JSON.stringify(years) !== JSON.stringify(window)) {
    throw configError('targetEndingYears', 'is invalid', `Expected exactly ${JSON.stringify(window)}, the five ending years up to the current season`, `targetEndingYears: ${JSON.stringify(window)}`);
  }
  config.seasonYearPinned = config.currentSeasonEndingYear !== undefined;
  config.currentSeasonEndingYear = seasonEndingYear;
  config.targetEndingYears = years;
  // The fewest eligible schools a school index may yield (#115); 0 disables the check.
  if (config.minEligibleSchools === undefined) config.minEligibleSchools = 0;
  if (!Number.isSafeInteger(config.minEligibleSchools) || config.minEligibleSchools < 0 || config.minEligibleSchools > 10_000) {
    throw configError('minEligibleSchools', 'is invalid', 'Expected an integer from 0 through 10000', 'minEligibleSchools: 300');
  }
  // A sample restricts the full scope above; it never replaces it (#78).
  try {
    config.crawlScope = createCrawlScope(config.crawlScope, { targetEndingYears: years });
  } catch (error) {
    throw new Error(`crawlScope is invalid: ${error.message}`);
  }
  try {
    config.crawlStage = assertCrawlStage(config.crawlStage ?? 'full');
  } catch (error) {
    throw new Error(`crawlStage is invalid: ${error.message}`);
  }
  if (!['memory', 'filesystem'].includes(config.rawStore)) {
    throw configError('rawStore', 'is invalid', 'Expected memory or filesystem', 'rawStore: memory');
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
  // The authorization record states the rules symbolically, so it stays valid as the season rolls.
  const expectedScope = { allowedHosts: config.allowedHosts, eligibilityPredicate: config.eligibilityPredicate, targetEndingYears: TARGET_YEARS_RULE };
  const requiresUpstream = config.mode === 'worker' || (config.mode === 'api' && config.publication === 'public');
  if (requiresUpstream) {
    const use = config.mode === 'worker' ? 'crawl' : 'publish';
    // Check authorization presence before the data contract so a missing
    // authorization is always reported first, even though it's also
    // rejected by the unconditional requireAuthorization call below. This
    // isn't dead code: without it, a missing authorization combined with an
    // invalid data contract would surface the data-contract error instead.
    if (!config.authorization) requireAuthorization(config.authorization, config.providerId, use, clock);
    const contract = requireDataContract(config.dataContract, config.providerId, clock, config.dataContract?.version);
    if (use === 'publish' && contract.redistribution !== 'public') throw configError('dataContract.redistribution', 'must permit public redistribution', 'Expected public', 'redistribution: public');
    if (config.authorization?.basis === 'personal_use_attestation' && contract.redistribution !== 'private') {
      throw configError('dataContract.redistribution', 'must be private for personal-use attestation', 'Expected private', 'redistribution: private');
    }
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
