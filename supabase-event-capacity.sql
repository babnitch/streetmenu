-- =============================================================================
-- Event capacity + manual approval + reservations toggle
-- Run this in Supabase SQL Editor (after supabase-event-reservations.sql)
-- =============================================================================
-- Adds the two organizer-controlled flags introduced in this batch:
--
--   requires_confirmation BOOLEAN — when TRUE, new reservations land
--                                   with reservation_status='pending'
--                                   and need an organizer confirm/reject
--                                   before they count toward attendance.
--                                   Default FALSE to preserve the current
--                                   auto-confirm behaviour for events
--                                   that don't opt in.
--
--   reservations_open     BOOLEAN — when FALSE, the reserve flow is
--                                   refused everywhere (web + WhatsApp).
--                                   Default TRUE; organizers can flip
--                                   it manually or it auto-flips when
--                                   the event sells out / is past.
--
-- Also widens the reservation_status CHECK constraint to include the
-- two new lifecycle states 'pending' and 'rejected'.
--
-- Idempotent — safe to re-run.
-- =============================================================================

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS requires_confirmation BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS reservations_open     BOOLEAN NOT NULL DEFAULT TRUE;

-- Drop the old CHECK constraint and re-create with the widened set.
-- Postgres constraint names are auto-generated; we look up the exact
-- name from pg_constraint so this works regardless of which migration
-- created the original.
DO $$
DECLARE
  cname TEXT;
BEGIN
  SELECT conname INTO cname
    FROM pg_constraint
   WHERE conrelid = 'public.event_reservations'::regclass
     AND contype  = 'c'
     AND pg_get_constraintdef(oid) LIKE '%reservation_status%';
  IF cname IS NOT NULL THEN
    EXECUTE format(
      'ALTER TABLE event_reservations DROP CONSTRAINT %I',
      cname
    );
  END IF;
END $$;

ALTER TABLE event_reservations
  ADD CONSTRAINT event_reservations_reservation_status_check
  CHECK (reservation_status IN ('pending', 'confirmed', 'cancelled', 'attended', 'rejected'));
