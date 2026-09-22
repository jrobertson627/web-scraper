BEGIN;

ALTER TABLE authorization_records ADD COLUMN IF NOT EXISTS effective_at TIMESTAMPTZ;
ALTER TABLE authorization_records ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;
ALTER TABLE authorization_records ADD COLUMN IF NOT EXISTS scope JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE authorization_records ADD COLUMN IF NOT EXISTS contract_version TEXT;
ALTER TABLE authorization_records ADD COLUMN IF NOT EXISTS contract_fingerprint TEXT;
ALTER TABLE publication_policies ADD COLUMN IF NOT EXISTS retained_fields JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE publication_policies ADD COLUMN IF NOT EXISTS fingerprint TEXT;
ALTER TABLE publication_policies ADD COLUMN IF NOT EXISTS effective_at TIMESTAMPTZ;
ALTER TABLE publication_policies ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE publication_policies ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS authorization_records_active_scope_idx ON authorization_records (provider_id, status, contract_version);
CREATE UNIQUE INDEX IF NOT EXISTS publication_policies_provider_version_idx ON publication_policies (provider_id, data_contract_version);

INSERT INTO schema_migrations (version) VALUES ('003_authorization_contract') ON CONFLICT (version) DO NOTHING;
COMMIT;
