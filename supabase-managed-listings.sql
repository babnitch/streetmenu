-- N3 — Admin-managed restaurants and events ("managed by Tchop & Ndjoka").
-- Run once in the Supabase SQL Editor. Safe to re-run.
--
-- managed_by_platform: listed by the admin with no owner / organiser yet.
--   A managed restaurant is Vitrine until it has an order contact (an order
--   number below, or a team member) AND the admin switches Commandes on.
--   Its WhatsApp number gets no owner commands in the bot.
--   A managed event takes free reservations only until an organiser is linked.
-- restaurant_order_phones: extra WhatsApp numbers that receive the
--   restaurant's orders (any restaurant; the only order contact of a managed
--   one until it has a team). Server-only (service role): RLS on, no policy.

ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS managed_by_platform boolean NOT NULL DEFAULT false;
ALTER TABLE events      ADD COLUMN IF NOT EXISTS managed_by_platform boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS restaurant_order_phones (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  phone         text NOT NULL CHECK (phone ~ '^\+[0-9]{8,15}$'),
  added_by      uuid NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, phone)
);
CREATE INDEX IF NOT EXISTS restaurant_order_phones_restaurant_idx ON restaurant_order_phones (restaurant_id);
ALTER TABLE restaurant_order_phones ENABLE ROW LEVEL SECURITY;

-- ── Checks (should return: 2 rows, then 1 row, then 0) ─────────────────────
-- SELECT table_name, column_name FROM information_schema.columns
--  WHERE column_name = 'managed_by_platform' AND table_name IN ('restaurants', 'events');
-- SELECT to_regclass('public.restaurant_order_phones');
-- SELECT count(*) FROM restaurants WHERE managed_by_platform;

-- ── Part 2 — a managed restaurant has no owner account ─────────────────────
-- supabase-optimization.sql had set restaurants.customer_id NOT NULL; the
-- sign-up paths still always set it, only the admin's managed listings
-- leave it empty.
ALTER TABLE restaurants ALTER COLUMN customer_id DROP NOT NULL;

-- Check (should return: YES)
-- SELECT is_nullable FROM information_schema.columns
--  WHERE table_name = 'restaurants' AND column_name = 'customer_id';
