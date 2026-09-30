BEGIN;

-- Raw objects are recorded by a reference that does not depend on the machine
-- that wrote them (#117): `raw:<first two hex digits>/<checksum>`, resolved to a
-- location by whichever raw store the worker is configured with. Before this the
-- reference was the worker's absolute path (file:///var/data/raw/xx/<checksum>),
-- so a worker on another machine, or a raw store moved to a new root or to
-- object storage, made every recorded object unreadable.
UPDATE source_fetches
  SET raw_object_path = 'raw:' || substr(checksum, 1, 2) || '/' || checksum
  WHERE checksum IS NOT NULL AND raw_object_path ~ '^(file|memory)://';

UPDATE raw_object_repair
  SET object_path = 'raw:' || substr(checksum, 1, 2) || '/' || checksum
  WHERE object_path ~ '^(file|memory)://' AND checksum ~ '^[a-f0-9]{64}$';

-- The id of the raw store this database's objects live in, recorded by the first
-- worker that runs. A worker, reprocess or repair run whose raw store has a
-- different id refuses to start, so a worker on the wrong machine, or one
-- pointed at an empty directory, cannot quietly write to a different store.
-- One row at most.
CREATE TABLE IF NOT EXISTS raw_store_identity (
  singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
  store_id TEXT NOT NULL CHECK (store_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

INSERT INTO schema_migrations(version) VALUES ('014_raw_store_identity') ON CONFLICT (version) DO NOTHING;
COMMIT;
