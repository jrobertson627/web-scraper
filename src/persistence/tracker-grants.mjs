// What the tracker's database role may read (#119).
//
// march-madness-tracker reads this database directly, so the role it connects as
// is given the versioned views (the `tracker_v<n>` schemas, migration 018) and
// nothing else: no table in `public`, and no other schema. The views run with
// their owner's privileges, so the role needs no access to the tables behind them.
// This builds the statements; scripts/grant-tracker.mjs runs them.

const ROLE = /^[a-z_][a-z0-9_]{0,62}$/;
export const TRACKER_SCHEMA = /^tracker_v[1-9]\d*$/;
export const DEFAULT_TRACKER_ROLE = 'tracker_readonly';

const quote = (identifier) => `"${identifier.replaceAll('"', '""')}"`;

export function assertRoleName(role) {
  if (typeof role !== 'string' || !ROLE.test(role)) {
    throw new Error(`role name ${JSON.stringify(role)} is invalid. Expected lowercase letters, digits and underscores. Example: ${DEFAULT_TRACKER_ROLE}`);
  }
  return role;
}

// The statements that leave `role` able to read `schemas` (tracker_v<n>) and
// connect to `database`, and nothing in `public`. Repeat-safe.
export function grantStatements({ role, schemas, database }) {
  assertRoleName(role);
  if (!schemas?.length || schemas.some((schema) => !TRACKER_SCHEMA.test(schema))) {
    throw new Error('the tracker role is granted tracker_v<n> schemas only. Example: tracker_v1');
  }
  if (typeof database !== 'string' || !database) throw new Error('a database name is required');
  const who = quote(role);
  return [
    // Undo any earlier grant on the tables themselves, such as a blanket SELECT.
    `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${who}`,
    `REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ${who}`,
    `REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM ${who}`,
    `REVOKE CREATE ON SCHEMA public FROM ${who}`,
    `GRANT CONNECT ON DATABASE ${quote(database)} TO ${who}`,
    ...schemas.flatMap((schema) => [
      `GRANT USAGE ON SCHEMA ${quote(schema)} TO ${who}`,
      `GRANT SELECT ON ALL TABLES IN SCHEMA ${quote(schema)} TO ${who}`,
      // Views a later migration adds to the same version (never a change to an existing one).
      `ALTER DEFAULT PRIVILEGES IN SCHEMA ${quote(schema)} GRANT SELECT ON TABLES TO ${who}`,
    ]),
  ];
}
