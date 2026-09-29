BEGIN;

-- The scopes a store was crawled under (#78). A sample crawl restricts the full
-- scope to named schools and ending years; recording it labels the data as a
-- sample, so it cannot be mistaken for complete coverage. The latest row is the
-- current scope; a store without rows was crawled under the full scope. A new
-- scope must cover the latest one (it may only widen).
CREATE TABLE IF NOT EXISTS crawl_scopes (
  id BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('sample','full')),
  schools JSONB,
  ending_years INTEGER[] NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK ((kind = 'sample') = (schools IS NOT NULL))
);

INSERT INTO schema_migrations(version) VALUES ('013_crawl_scopes') ON CONFLICT (version) DO NOTHING;
COMMIT;
