BEGIN;

-- Keep the Supabase API roles out of this database (#158). Supabase exposes the
-- `public` schema through its REST API and gives the roles `anon` and
-- `authenticated` default privileges on the tables created there. This schema has
-- no row-level security, so with the Data API on, anyone holding the project's
-- publishable key could read every table: the parsed data, the raw-fetch records,
-- the authorization records and the operator dispositions. Nothing here is meant
-- for the API: the worker and the tracker connect over SQL, the tracker through
-- the tracker_v<n> views only (migration 018, npm run grant:tracker).
--
-- Where those two roles exist (a Supabase project), this
--   - revokes everything they hold on the tables, sequences and functions in
--     `public` and on the tracker_v<n> schemas, and on tables created later by the
--     role running the migration, so a new table is not exposed by default;
--   - enables row-level security on every table in `public`, so the security
--     advisor does not report them as open. There are no policies, so the roles
--     see no rows even if a privilege is granted again. The table owner, which is
--     the role the worker and the migrations connect as, bypasses row-level
--     security, and so do the tracker views, which run with their owner's
--     privileges.
-- Where they do not exist (CI's plain PostgreSQL, a local database) it does
-- nothing. The schema's own USAGE grant is left alone. It is repeat-safe.
--
-- Enabling row-level security takes a brief ACCESS EXCLUSIVE lock on each table
-- (the migration run's lock_timeout, 5 s, makes a blocked one fail the deploy). It
-- assumes one role owns the tables; a role that only holds grants on them would
-- see no rows after this.

DO $$
DECLARE
  api_roles TEXT;
  target TEXT;
  rel TEXT;
BEGIN
  SELECT string_agg(quote_ident(rolname), ', ' ORDER BY rolname) INTO api_roles
  FROM pg_roles WHERE rolname IN ('anon', 'authenticated');
  IF api_roles IS NULL THEN
    RETURN;
  END IF;

  FOR target IN
    SELECT quote_ident(nspname) FROM pg_namespace
    WHERE nspname = 'public' OR nspname ~ '^tracker_v[1-9][0-9]*$'
  LOOP
    EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA %s FROM %s', target, api_roles);
    EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA %s FROM %s', target, api_roles);
    EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA %s FROM %s', target, api_roles);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %s REVOKE ALL ON TABLES FROM %s', target, api_roles);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %s REVOKE ALL ON SEQUENCES FROM %s', target, api_roles);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %s REVOKE ALL ON FUNCTIONS FROM %s', target, api_roles);
  END LOOP;
  -- Nothing in a tracker_v<n> schema is for the API either.
  FOR target IN SELECT quote_ident(nspname) FROM pg_namespace WHERE nspname ~ '^tracker_v[1-9][0-9]*$' LOOP
    EXECUTE format('REVOKE ALL ON SCHEMA %s FROM %s', target, api_roles);
  END LOOP;

  FOR rel IN
    SELECT quote_ident(c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relrowsecurity
  LOOP
    EXECUTE format('ALTER TABLE public.%s ENABLE ROW LEVEL SECURITY', rel);
  END LOOP;
END
$$;

INSERT INTO schema_migrations(version) VALUES ('020_revoke_api_roles') ON CONFLICT (version) DO NOTHING;
COMMIT;
