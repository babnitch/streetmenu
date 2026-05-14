-- =============================================================================
-- Event publisher trust + commission
-- Run this in Supabase SQL Editor (after supabase-event-reservations.sql)
-- =============================================================================
-- Light-touch publisher model: any logged-in customer can submit events.
-- Admin reviews each one until the customer has 3 approved events; after
-- that, future submissions auto-approve. Commission is recorded per
-- reservation so the organizer payout can be reconciled.
-- Idempotent — safe to re-run.
-- =============================================================================

-- 1. customers: trust counters --------------------------------------------------
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS events_submitted_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS events_approved_count  INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS event_auto_approve     BOOLEAN NOT NULL DEFAULT FALSE;

-- 2. events: commission settings + auto_approve flag ---------------------------
-- commission_rate is per-event so an admin could one-off lower it for a
-- promotional event. Default 10% matches the spec.
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS commission_rate  NUMERIC(5,4) NOT NULL DEFAULT 0.10,
  ADD COLUMN IF NOT EXISTS commission_amount INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS auto_approved    BOOLEAN     NOT NULL DEFAULT FALSE;

-- 3. event_reservations: per-row commission ------------------------------------
-- Computed at insert time as ROUND(total_price × commission_rate). Free
-- reservations (total_price=0) stay 0.
ALTER TABLE event_reservations
  ADD COLUMN IF NOT EXISTS commission_amount INTEGER NOT NULL DEFAULT 0;
