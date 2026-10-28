-- V1–V5: delivery, offer of the day, favourites. Safe to re-run.
-- Run in the Supabase SQL Editor, then reply "SQL done".
-- Everything here is new and off by default: no restaurant delivers until it
-- switches delivery on, no offer exists until one is created.

-- ── V1 Delivery (the restaurant's own rider) ───────────────────────────────
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS delivery_enabled   boolean NOT NULL DEFAULT false;
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS delivery_fee       integer NOT NULL DEFAULT 0;
-- Minutes added to the preparation time for the ride ("25–35 min").
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS delivery_extra_min integer NOT NULL DEFAULT 15;

DO $$ BEGIN
  ALTER TABLE restaurants ADD CONSTRAINT restaurants_delivery_fee_ok CHECK (delivery_fee >= 0 AND delivery_fee <= 100000);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE restaurants ADD CONSTRAINT restaurants_delivery_extra_ok CHECK (delivery_extra_min >= 0 AND delivery_extra_min <= 180);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE orders ADD COLUMN IF NOT EXISTS fulfilment        text    NOT NULL DEFAULT 'pickup';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_fee      integer NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_address  text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_landmark text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_phone    text;

DO $$ BEGIN
  ALTER TABLE orders ADD CONSTRAINT orders_fulfilment_ok CHECK (fulfilment IN ('pickup', 'delivery'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE orders ADD CONSTRAINT orders_delivery_fee_ok CHECK (delivery_fee >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- A delivery order always carries an address.
DO $$ BEGIN
  ALTER TABLE orders ADD CONSTRAINT orders_delivery_address_ok
    CHECK (fulfilment <> 'delivery' OR coalesce(btrim(delivery_address), '') <> '');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── V2 Offer of the day ────────────────────────────────────────────────────
-- kind 'price':         a dish at offer_price, from starts_on to ends_on.
-- kind 'free_delivery': the restaurant's delivery fee is 0 on those days
--                       (menu_item_id empty).
-- Days are the restaurant's own (restaurants.timezone, else Africa/Douala),
-- so an offer ends by itself at midnight after ends_on.
CREATE TABLE IF NOT EXISTS menu_offers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  menu_item_id  uuid REFERENCES menu_items(id) ON DELETE CASCADE,
  kind          text NOT NULL,
  offer_price   integer,
  starts_on     date NOT NULL,
  ends_on       date NOT NULL,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT menu_offers_kind_ok  CHECK (kind IN ('price', 'free_delivery')),
  CONSTRAINT menu_offers_shape_ok CHECK (
    (kind = 'price'         AND menu_item_id IS NOT NULL AND offer_price IS NOT NULL AND offer_price > 0)
 OR (kind = 'free_delivery' AND menu_item_id IS NULL     AND offer_price IS NULL)
  ),
  CONSTRAINT menu_offers_dates_ok CHECK (ends_on >= starts_on AND ends_on - starts_on <= 60)
);
CREATE INDEX IF NOT EXISTS menu_offers_restaurant_days ON menu_offers (restaurant_id, ends_on);
CREATE INDEX IF NOT EXISTS menu_offers_item           ON menu_offers (menu_item_id);
-- Server-only, like orders: the app reads and writes it with the service role.
ALTER TABLE menu_offers ENABLE ROW LEVEL SECURITY;

-- ── V4 Favourites ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS customer_favorites (
  customer_id   uuid NOT NULL REFERENCES customers(id)   ON DELETE CASCADE,
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, restaurant_id)
);
CREATE INDEX IF NOT EXISTS customer_favorites_restaurant ON customer_favorites (restaurant_id);
ALTER TABLE customer_favorites ENABLE ROW LEVEL SECURITY;

-- V3 (home page) and V5 (pictures required) need no SQL.

NOTIFY pgrst, 'reload schema';

-- ── Check (expect 3 rows, then 5 rows, then 2 rows) ────────────────────────
-- SELECT column_name FROM information_schema.columns
--  WHERE table_name = 'restaurants' AND column_name IN ('delivery_enabled','delivery_fee','delivery_extra_min');
-- SELECT column_name FROM information_schema.columns
--  WHERE table_name = 'orders' AND column_name IN ('fulfilment','delivery_fee','delivery_address','delivery_landmark','delivery_phone');
-- SELECT table_name FROM information_schema.tables
--  WHERE table_name IN ('menu_offers','customer_favorites');
