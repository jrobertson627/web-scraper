export function authorizationStatus(record, providerId, requiredUse) {
  if (!record) return { ok: false, reason: 'missing authorization evidence' };
  if (record.providerId !== providerId) return { ok: false, reason: `authorization provider mismatch: expected ${providerId}` };
  if (record.status !== 'active') return { ok: false, reason: `authorization is ${record.status}; expected active` };
  if (!record.uses?.includes(requiredUse)) return { ok: false, reason: `authorization does not cover ${requiredUse}` };
  if (record.expiresAt && new Date(record.expiresAt) <= new Date()) return { ok: false, reason: 'authorization is expired' };
  if (!record.evidenceRef) return { ok: false, reason: 'authorization evidence reference is missing' };
  return { ok: true };
}

export function requireAuthorization(record, providerId, requiredUse) {
  const result = authorizationStatus(record, providerId, requiredUse);
  if (!result.ok) {
    throw new Error(`${result.reason}. Expected active authorization for ${providerId}/${requiredUse}. Example: authorization.status: active`);
  }
  return record;
}
