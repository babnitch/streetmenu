-- =============================================================================
-- Short reservation codes for event_reservations
-- Run this in the Supabase SQL Editor BEFORE deploying the code that reads it.
-- =============================================================================
-- Gives every reservation a human-friendly 4-char code (e.g. "A3F7") that
-- customers quote to the organizer and organizers use for check-in — the same
-- role #XXXX plays for orders. New rows get an app-generated unique code;
-- existing rows are backfilled from their id hash. Idempotent — safe to re-run.
-- =============================================================================

-- 1. Column (nullable so the app can set it explicitly per row).
ALTER TABLE event_reservations
  ADD COLUMN IF NOT EXISTS reservation_code TEXT;

-- 2. Backfill existing rows. UPPER(4 hex of MD5(id)) is deterministic per row.
--    On the current data volume collisions are effectively impossible; if a
--    future re-run ever hit one, widen the substring below before step 3.
UPDATE event_reservations
  SET reservation_code = UPPER(SUBSTR(MD5(id::text), 1, 4))
  WHERE reservation_code IS NULL;

-- 3. Enforce global uniqueness. A UNIQUE INDEX (not NOT NULL) still permits the
--    brief NULL window during an insert, and Postgres allows multiple NULLs —
--    but the app always supplies a code, so in practice every row is unique.
CREATE UNIQUE INDEX IF NOT EXISTS event_reservations_reservation_code_key
  ON event_reservations(reservation_code);
