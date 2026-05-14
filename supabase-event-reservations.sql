-- =============================================================================
-- Event reservations + ticketing
-- Run this in Supabase SQL Editor
-- =============================================================================
-- Adds the columns events need to support paid + capped reservations and
-- creates the event_reservations table that tracks each ticket claim.
-- Idempotent — safe to re-run.
-- =============================================================================

-- 1. Extend events ------------------------------------------------------------
-- ticket_price intentionally lives alongside the legacy `price` column so the
-- list/detail pages keep rendering during the migration window. Once every
-- row is backfilled, `price` can be dropped in a follow-up.
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS payment_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS ticket_price    INTEGER,
  ADD COLUMN IF NOT EXISTS max_tickets     INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tickets_sold    INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS organizer_id    UUID REFERENCES customers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS event_status    TEXT NOT NULL DEFAULT 'upcoming'
    CHECK (event_status IN ('upcoming', 'ongoing', 'completed', 'cancelled'));

-- Backfill ticket_price from the legacy numeric `price` column where the new
-- column is still NULL. Cast to integer (FCFA has no minor unit).
UPDATE events
   SET ticket_price = ROUND(price)::INTEGER
 WHERE ticket_price IS NULL
   AND price IS NOT NULL;

-- 2. event_reservations -------------------------------------------------------
CREATE TABLE IF NOT EXISTS event_reservations (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id            UUID        NOT NULL REFERENCES events(id)    ON DELETE CASCADE,
  customer_id         UUID        REFERENCES customers(id)          ON DELETE SET NULL,
  customer_name       TEXT        NOT NULL,
  customer_phone      TEXT        NOT NULL,
  quantity            INTEGER     NOT NULL DEFAULT 1 CHECK (quantity > 0),
  total_price         INTEGER     NOT NULL DEFAULT 0,
  payment_status      TEXT        NOT NULL DEFAULT 'not_required'
    CHECK (payment_status IN ('not_required', 'pending', 'paid', 'failed')),
  payment_id          TEXT,        -- PawaPay deposit id when paid
  payment_method      TEXT,
  reservation_status  TEXT        NOT NULL DEFAULT 'confirmed'
    CHECK (reservation_status IN ('confirmed', 'cancelled', 'attended')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Service-role-only RLS. Customer reads go through /api/customer/reservations
-- (uses supabaseAdmin), the same pattern the orders table uses.
ALTER TABLE event_reservations ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename  = 'event_reservations'
       AND policyname = 'service_role_only'
  ) THEN
    CREATE POLICY "service_role_only" ON event_reservations USING (false);
  END IF;
END $$;

-- 3. Indexes ------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS event_reservations_event_id_idx        ON event_reservations(event_id);
CREATE INDEX IF NOT EXISTS event_reservations_customer_id_idx     ON event_reservations(customer_id);
CREATE INDEX IF NOT EXISTS event_reservations_payment_status_idx  ON event_reservations(payment_status);
CREATE INDEX IF NOT EXISTS event_reservations_status_idx          ON event_reservations(reservation_status);
