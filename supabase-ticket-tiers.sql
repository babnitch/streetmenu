-- =============================================================================
-- Event ticket tiers (Early Bird / VIP / Kids / etc.)
-- Run this in Supabase SQL Editor (after supabase-event-capacity.sql)
-- =============================================================================
-- Lets an organizer attach multiple priced tiers to a single event.
--
-- Backward compatible: events with zero rows in event_ticket_tiers
-- continue to use events.ticket_price + events.max_tickets exactly as
-- before. When tiers exist, the events.ticket_price field is ignored
-- and the price + capacity gates move to the tier rows.
--
-- Reservations carry the tier_id, plus a denormalised tier_name and
-- tier_price snapshot — so admin reports + customer history survive
-- the tier being renamed or deleted later.
--
-- Idempotent.
-- =============================================================================

CREATE TABLE IF NOT EXISTS event_ticket_tiers (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id      UUID        NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name          TEXT        NOT NULL,
  name_en       TEXT,
  price         INTEGER     NOT NULL DEFAULT 0,
  max_quantity  INTEGER     NOT NULL DEFAULT 0,      -- 0 = unlimited
  sold_count    INTEGER     NOT NULL DEFAULT 0,
  sort_order    INTEGER     NOT NULL DEFAULT 0,
  is_active     BOOLEAN     NOT NULL DEFAULT TRUE,
  sales_start   TIMESTAMPTZ,
  sales_end     TIMESTAMPTZ,
  description   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE event_ticket_tiers ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename  = 'event_ticket_tiers'
       AND policyname = 'service_role_only'
  ) THEN
    CREATE POLICY "service_role_only" ON event_ticket_tiers USING (false);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS event_ticket_tiers_event_id_idx ON event_ticket_tiers(event_id);
CREATE INDEX IF NOT EXISTS event_ticket_tiers_active_idx   ON event_ticket_tiers(is_active);

-- Reservation rows learn about the tier they came from. Denormalised
-- columns survive tier renames/deletions so the customer + admin views
-- never end up with phantom blank rows.
ALTER TABLE event_reservations
  ADD COLUMN IF NOT EXISTS tier_id    UUID REFERENCES event_ticket_tiers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS tier_name  TEXT,
  ADD COLUMN IF NOT EXISTS tier_price INTEGER;

CREATE INDEX IF NOT EXISTS event_reservations_tier_id_idx ON event_reservations(tier_id);
