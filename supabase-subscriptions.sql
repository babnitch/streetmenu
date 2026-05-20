-- =============================================================================
-- Event subscriptions + paid broadcasts
-- Run this in Supabase SQL Editor
-- =============================================================================
-- Lets customers opt into WhatsApp notifications for new events in their
-- city (optionally filtered to a subset of categories), and lets verified
-- publishers + approved restaurant owners pay to broadcast custom messages
-- to those subscribers.
--
-- Idempotent — safe to re-run.
-- =============================================================================

-- 1. event_subscriptions ------------------------------------------------------
-- One row per (customer, city) pairing. `categories` NULL means "all
-- categories"; otherwise the array is the whitelist (e.g. ['Concert','Enfants']).
-- Unsubscribe is soft: is_active=false + unsubscribed_at set, so re-subscribing
-- later updates the same row instead of inserting duplicates.
CREATE TABLE IF NOT EXISTS event_subscriptions (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id     UUID        NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  city            TEXT        NOT NULL,
  categories      TEXT[],
  is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  unsubscribed_at TIMESTAMPTZ,
  UNIQUE (customer_id, city)
);

ALTER TABLE event_subscriptions ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename  = 'event_subscriptions'
       AND policyname = 'service_role_only'
  ) THEN
    CREATE POLICY "service_role_only" ON event_subscriptions USING (false);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS event_subscriptions_customer_id_idx ON event_subscriptions(customer_id);
CREATE INDEX IF NOT EXISTS event_subscriptions_city_active_idx ON event_subscriptions(city) WHERE is_active = TRUE;

-- 2. broadcasts ---------------------------------------------------------------
-- A paid broadcast composed by a publisher or restaurant owner. Lifecycle:
--   draft  → user composes
--   paid   → PawaPay deposit COMPLETED, ready to send
--   sending→ fan-out in progress
--   sent   → all recipients attempted
--   failed → payment failed or fan-out errored hard
CREATE TABLE IF NOT EXISTS broadcasts (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id         UUID        NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  sender_type       TEXT        NOT NULL CHECK (sender_type IN ('publisher','restaurant')),
  restaurant_id     UUID        REFERENCES restaurants(id) ON DELETE SET NULL,
  title             TEXT        NOT NULL,
  message           TEXT        NOT NULL CHECK (char_length(message) <= 1000),
  target_city       TEXT        NOT NULL,
  target_categories TEXT[],
  recipient_count   INTEGER     NOT NULL DEFAULT 0,
  cost              INTEGER     NOT NULL,
  payment_status    TEXT        NOT NULL DEFAULT 'pending'
    CHECK (payment_status IN ('pending','paid','failed')),
  payment_id        TEXT,
  status            TEXT        NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','paid','sending','sent','failed')),
  sent_at           TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE broadcasts ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename  = 'broadcasts'
       AND policyname = 'service_role_only'
  ) THEN
    CREATE POLICY "service_role_only" ON broadcasts USING (false);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS broadcasts_sender_id_idx     ON broadcasts(sender_id);
CREATE INDEX IF NOT EXISTS broadcasts_target_city_idx   ON broadcasts(target_city);
CREATE INDEX IF NOT EXISTS broadcasts_status_idx        ON broadcasts(status);
CREATE INDEX IF NOT EXISTS broadcasts_created_at_idx    ON broadcasts(created_at);
CREATE INDEX IF NOT EXISTS broadcasts_payment_id_idx    ON broadcasts(payment_id);

-- Customer block flag — admin sets `broadcast_blocked=true` on a customers
-- row to prevent that account from creating new broadcasts. Existing rows
-- aren't retracted. Default false.
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS broadcast_blocked BOOLEAN NOT NULL DEFAULT FALSE;

-- 3. broadcast_pricing --------------------------------------------------------
-- Single-row config table. The active row's `price_per_recipient` and
-- `min_charge` drive cost calculation; `max_message_length` caps the textarea
-- on the compose form. Admin can flip rows by toggling is_active.
CREATE TABLE IF NOT EXISTS broadcast_pricing (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  price_per_recipient INTEGER     NOT NULL DEFAULT 50,
  min_charge          INTEGER     NOT NULL DEFAULT 1000,
  max_message_length  INTEGER     NOT NULL DEFAULT 1000,
  is_active           BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE broadcast_pricing ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename  = 'broadcast_pricing'
       AND policyname = 'service_role_only'
  ) THEN
    CREATE POLICY "service_role_only" ON broadcast_pricing USING (false);
  END IF;
END $$;

-- Seed default pricing row (50 FCFA/recipient, 1,000 FCFA minimum). Skipped
-- if any pricing row already exists.
INSERT INTO broadcast_pricing (price_per_recipient, min_charge, max_message_length, is_active)
SELECT 50, 1000, 1000, TRUE
WHERE NOT EXISTS (SELECT 1 FROM broadcast_pricing);
