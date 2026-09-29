// Who may record an operator disposition: releasing an operator_stop job, or
// accepting or dismissing a quarantined record (#48). Both persistence adapters
// deny by default; a process that records dispositions passes the authorizer
// built here from OPERATOR_IDS, a comma-separated allowlist.
//
// The allowlist names reviewers; it does not authenticate them. Whoever can run
// the review command already holds the database credentials, so the credentials
// are the real gate and the allowlist makes every recorded "who" one of the
// named reviewers. See DEPLOYMENT.md.

export { DENY_ALL_OPERATORS } from '../contracts/jobs.mjs';

const OPERATOR_ID = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/;

export function operatorAllowlist(value) {
  if (value === undefined || value === null || value === '') return Object.freeze([]);
  const ids = String(value).split(',').map((id) => id.trim()).filter(Boolean);
  if (!ids.length || ids.some((id) => !OPERATOR_ID.test(id))) {
    throw new Error('OPERATOR_IDS is invalid. Expected comma-separated operator ids of letters, digits, ".", "_", "@" or "-". Example: OPERATOR_IDS=jessica');
  }
  return Object.freeze([...new Set(ids)]);
}

export function operatorAuthorizer(value) {
  const allowed = new Set(operatorAllowlist(value));
  return (operatorId) => typeof operatorId === 'string' && allowed.has(operatorId);
}
