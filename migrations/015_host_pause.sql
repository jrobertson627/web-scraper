BEGIN;

-- A 429 pauses the whole host, not just the page that got it (#113). The host's
-- request schedule holds the time before which no request to it may start, so
-- whichever job is claimed next waits, and a restarted worker keeps waiting.
ALTER TABLE host_request_schedule ADD COLUMN IF NOT EXISTS paused_until TIMESTAMPTZ;

INSERT INTO schema_migrations(version) VALUES ('015_host_pause') ON CONFLICT (version) DO NOTHING;
COMMIT;
