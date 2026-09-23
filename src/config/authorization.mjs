import { contractFingerprint } from './data-contract.mjs';

function sameScope(actual, expected) {
  if (!expected) return true;
  return contractFingerprint(actual ?? {}) === contractFingerprint(expected);
}

export function authorizationStatus(record, providerId, requiredUse, clock = () => new Date(), options = {}) {
  if (!record) return { ok: false, reason: 'missing authorization evidence' };
  if (record.providerId !== providerId) return { ok: false, reason: `authorization provider mismatch: expected ${providerId}` };
  if (record.status !== 'active') return { ok: false, reason: `authorization is ${record.status}; expected active` };
  if (record.basis === 'personal_use_attestation') {
    if (requiredUse !== 'crawl') return { ok: false, reason: 'personal-use attestation does not cover publish' };
    if (!Array.isArray(record.uses) || record.uses.length !== 1 || record.uses[0] !== 'crawl') {
      return { ok: false, reason: 'personal-use attestation must cover crawl only' };
    }
    if (typeof record.evidenceRef !== 'string' || !record.evidenceRef.startsWith('operator-attestation:')) {
      return { ok: false, reason: 'personal-use attestation evidenceRef must identify an operator attestation' };
    }
  }
  if (!record.uses?.includes(requiredUse)) return { ok: false, reason: `authorization does not cover ${requiredUse}` };
  if (!sameScope(record.scope, options.expectedScope)) return { ok: false, reason: 'authorization scope does not match configured crawl scope' };
  if (options.expectedContractVersion && record.contractVersion !== options.expectedContractVersion) return { ok: false, reason: `authorization data contract version mismatch: expected ${options.expectedContractVersion}` };
  if (options.expectedContractFingerprint && record.contractFingerprint !== options.expectedContractFingerprint) return { ok: false, reason: 'authorization data contract fingerprint does not match configured contract' };
  if (record.effectiveAt) {
    const effectiveAt = new Date(record.effectiveAt);
    if (Number.isNaN(effectiveAt.getTime())) return { ok: false, reason: 'authorization effective date is invalid' };
    if (effectiveAt > clock()) return { ok: false, reason: 'authorization is not yet effective' };
  }
  if (record.expiresAt) {
    const expiresAt = new Date(record.expiresAt);
    if (Number.isNaN(expiresAt.getTime())) return { ok: false, reason: 'authorization expiry is invalid' };
    if (expiresAt <= clock()) return { ok: false, reason: 'authorization is expired' };
  }
  if (record.revokedAt) {
    const revokedAt = new Date(record.revokedAt);
    if (Number.isNaN(revokedAt.getTime())) return { ok: false, reason: 'authorization revocation date is invalid' };
    if (revokedAt <= clock()) return { ok: false, reason: 'authorization is revoked' };
  }
  if (!record.evidenceRef) return { ok: false, reason: 'authorization evidence reference is missing' };
  return { ok: true };
}

export function requireAuthorization(record, providerId, requiredUse, clock = () => new Date(), options = {}) {
  const result = authorizationStatus(record, providerId, requiredUse, clock, options);
  if (!result.ok) {
    throw new Error(`${result.reason}. Expected active authorization for ${providerId}/${requiredUse}. Example: authorization.status: active`);
  }
  return record;
}

export function publicationStatus(authorization, dataContract, providerId, clock = () => new Date(), options = {}) {
  const auth = authorizationStatus(authorization, providerId, 'publish', clock, options);
  if (!auth.ok) return auth;
  if (!dataContract) return { ok: false, reason: 'missing data contract' };
  if (options.expectedContractVersion && dataContract.version !== options.expectedContractVersion) return { ok: false, reason: `data contract version mismatch: expected ${options.expectedContractVersion}` };
  if (dataContract.redistribution !== 'public') return { ok: false, reason: 'data contract does not permit public redistribution' };
  const { dataContractStatus } = options;
  return dataContractStatus ? dataContractStatus(dataContract, providerId, clock, options.expectedContractVersion) : { ok: true };
}
