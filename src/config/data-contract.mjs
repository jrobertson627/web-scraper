import { createHash } from 'node:crypto';

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function contractFingerprint(contract) {
  const { fingerprint: _ignored, ...content } = contract ?? {};
  return createHash('sha256').update(canonical(content)).digest('hex');
}

export function createDataContract(input) {
  const contract = structuredClone(input ?? {});
  if (typeof contract.providerId !== 'string' || !contract.providerId) throw new Error('dataContract.providerId is missing');
  if (typeof contract.version !== 'string' || !contract.version) throw new Error('dataContract.version is missing');
  if (!Array.isArray(contract.retainedFields) || contract.retainedFields.length === 0 || contract.retainedFields.some((field) => typeof field !== 'string' || !field)) {
    throw new Error('dataContract.retainedFields must list retained fields');
  }
  if (typeof contract.attribution !== 'string' || !contract.attribution) throw new Error('dataContract.attribution is missing');
  if (typeof contract.sourceLinksRequired !== 'boolean') throw new Error('dataContract.sourceLinksRequired must be boolean');
  if (!['private', 'public'].includes(contract.redistribution)) throw new Error('dataContract.redistribution must be private or public');
  if (typeof contract.retention !== 'string' || !contract.retention) throw new Error('dataContract.retention is missing');
  const expectedFingerprint = contractFingerprint(contract);
  if (contract.fingerprint && contract.fingerprint !== expectedFingerprint) throw new Error('dataContract.fingerprint does not match contract content');
  contract.fingerprint = expectedFingerprint;
  return deepFreeze(contract);
}

export function dataContractStatus(contract, providerId, clock = () => new Date(), expectedVersion) {
  if (!contract) return { ok: false, reason: 'missing data contract' };
  if (contract.providerId !== providerId) return { ok: false, reason: `data contract provider mismatch: expected ${providerId}` };
  if (expectedVersion && contract.version !== expectedVersion) return { ok: false, reason: `data contract version mismatch: expected ${expectedVersion}` };
  try { createDataContract(contract); } catch (error) { return { ok: false, reason: error.message.replace(/^dataContract\./, 'data contract ') }; }
  const now = clock();
  if (contract.effectiveAt) {
    const effectiveAt = new Date(contract.effectiveAt);
    if (Number.isNaN(effectiveAt.getTime())) return { ok: false, reason: 'data contract effective date is invalid' };
    if (effectiveAt > now) return { ok: false, reason: 'data contract is not yet effective' };
  }
  if (contract.expiresAt) {
    const expiresAt = new Date(contract.expiresAt);
    if (Number.isNaN(expiresAt.getTime())) return { ok: false, reason: 'data contract expiry is invalid' };
    if (expiresAt <= now) return { ok: false, reason: 'data contract is expired' };
  }
  if (contract.revokedAt) {
    const revokedAt = new Date(contract.revokedAt);
    if (Number.isNaN(revokedAt.getTime())) return { ok: false, reason: 'data contract revocation date is invalid' };
    if (revokedAt <= now) return { ok: false, reason: 'data contract is revoked' };
  }
  return { ok: true, fingerprint: contract.fingerprint };
}

export function requireDataContract(contract, providerId, clock = () => new Date(), expectedVersion) {
  const result = dataContractStatus(contract, providerId, clock, expectedVersion);
  if (!result.ok) throw new Error(`${result.reason}. Expected an active versioned data contract for ${providerId}. Example: dataContract.version: 'v1'`);
  return contract;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
