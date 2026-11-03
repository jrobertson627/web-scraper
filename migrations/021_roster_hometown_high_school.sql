BEGIN;

-- Hometown and high school as columns of the roster row. The season parser has
-- always read both from the roster table (as optional `extra` values, next to the
-- recruiting rank), but they were stored only inside `extra`, so nothing outside
-- the parser could ask for them. They become named columns beside jersey_number,
-- class, position, height and weight, and the next tracker version (migration 022)
-- exposes them.
--
-- NULL means the source gave no value; value_states says why, as for the other
-- roster columns: `blank` (the cell was empty) or `unavailable` (the roster table
-- has no such column). `extra` is left as it is, so this migration loses nothing
-- and an older build still writes what it always did.
--
-- Rows stored before this migration are filled from their `extra`, so a reader
-- need not wait for a reprocess. A row whose `extra` has neither key (a page parsed
-- before the parser read them) stays NULL. Repeat-safe.

ALTER TABLE season_rosters ADD COLUMN IF NOT EXISTS hometown TEXT;
ALTER TABLE season_rosters ADD COLUMN IF NOT EXISTS high_school TEXT;

UPDATE season_rosters SET
  hometown = CASE WHEN extra -> 'hometown' ->> 'state' = 'present' THEN extra -> 'hometown' ->> 'value' END,
  high_school = CASE WHEN extra -> 'high_school' ->> 'state' = 'present' THEN extra -> 'high_school' ->> 'value' END,
  value_states = value_states
    || CASE WHEN extra -> 'hometown' ->> 'state' IN ('blank', 'unavailable', 'null')
         THEN jsonb_build_object('hometown', extra -> 'hometown') ELSE '{}'::jsonb END
    || CASE WHEN extra -> 'high_school' ->> 'state' IN ('blank', 'unavailable', 'null')
         THEN jsonb_build_object('highSchool', extra -> 'high_school') ELSE '{}'::jsonb END
WHERE extra ? 'hometown' OR extra ? 'high_school';

INSERT INTO schema_migrations(version) VALUES ('021_roster_hometown_high_school') ON CONFLICT (version) DO NOTHING;
COMMIT;
