-- Q — QR codes that are links, check-in, delivery confirmation, door staff,
-- riders. One file for Q1–Q5. Run once in the Supabase SQL Editor; safe to
-- re-run. Every new table is server-only: RLS on, no policy.

-- 1. Scan tokens (Q1). A token is HMAC(SCAN_TOKEN_SECRET, kind:id:version),
--    shown in the QR as https://<site>/scan/<token>; only its SHA-256 is
--    stored. A higher version for the same item revokes the old QR.
CREATE TABLE IF NOT EXISTS scan_tokens (
  token_hash  text PRIMARY KEY,
  kind        text NOT NULL CHECK (kind IN ('reservation', 'order', 'voucher')),
  target_id   uuid NOT NULL,
  version     smallint NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, target_id, version)
);
ALTER TABLE scan_tokens ENABLE ROW LEVEL SECURITY;

-- 2. Event check-ins (Q2): one per reservation per day — a multi-day ticket
--    is checked in once each day. The whole group at once (people).
CREATE TABLE IF NOT EXISTS event_checkins (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id  uuid NOT NULL REFERENCES event_reservations(id) ON DELETE CASCADE,
  event_id        uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  day             date NOT NULL,
  people          smallint NOT NULL DEFAULT 1,
  checked_in_by   uuid NULL,
  checked_in_by_type text NOT NULL DEFAULT 'customer' CHECK (checked_in_by_type IN ('customer', 'admin')),
  via             text NOT NULL DEFAULT 'scan' CHECK (via IN ('scan', 'code')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (reservation_id, day)
);
CREATE INDEX IF NOT EXISTS event_checkins_event_idx ON event_checkins (event_id, day);
ALTER TABLE event_checkins ENABLE ROW LEVEL SECURITY;

-- 2b. One booking = one QR (Q1): the rows of one booking (one per ticket
--     tier) share booking_id; one scan checks the whole booking in. Older
--     rows have none and stand alone.
ALTER TABLE event_reservations ADD COLUMN IF NOT EXISTS booking_id uuid;
CREATE INDEX IF NOT EXISTS event_reservations_booking_idx ON event_reservations (booking_id) WHERE booking_id IS NOT NULL;

-- 3. Orders (Q2 / Q5): "en livraison" status, who confirmed the delivery /
--    hand-over (Prompt P releases money from this), the assigned rider.
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_chk;
ALTER TABLE orders ADD CONSTRAINT orders_status_chk
  CHECK (status IN ('pending', 'confirmed', 'preparing', 'ready', 'out_for_delivery', 'delivered', 'completed', 'cancelled'));
ALTER TABLE orders ADD COLUMN IF NOT EXISTS out_for_delivery_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivered_at        timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivered_confirmed_by text
  CHECK (delivered_confirmed_by IN ('customer', 'rider', 'restaurant_scan', 'restaurant_code', 'restaurant_manual', 'auto'));
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivered_actor_id   uuid;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivered_actor_type text CHECK (delivered_actor_type IN ('customer', 'admin'));

-- 4. Vouchers (Q2): who used it, and where.
ALTER TABLE customer_vouchers ADD COLUMN IF NOT EXISTS used_by            uuid;
ALTER TABLE customer_vouchers ADD COLUMN IF NOT EXISTS used_by_type       text CHECK (used_by_type IN ('customer', 'admin'));
ALTER TABLE customer_vouchers ADD COLUMN IF NOT EXISTS used_restaurant_id uuid REFERENCES restaurants(id) ON DELETE SET NULL;

-- 5. Door staff (Q4): may scan / check in for ONE event, nothing else.
CREATE TABLE IF NOT EXISTS event_door_staff (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id     uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  customer_id  uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  added_by     uuid NULL,
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, customer_id)
);
CREATE INDEX IF NOT EXISTS event_door_staff_customer_idx ON event_door_staff (customer_id) WHERE status = 'active';
ALTER TABLE event_door_staff ENABLE ROW LEVEL SECURITY;

-- 6. Riders (Q5): optional, per restaurant. 'none' (default) = riders are
--    not on the app; 'app' = riders with accounts see only their deliveries.
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS riders_mode text NOT NULL DEFAULT 'none'
  CHECK (riders_mode IN ('none', 'app'));
CREATE TABLE IF NOT EXISTS restaurant_riders (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id  uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  customer_id    uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  added_by       uuid NULL,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, customer_id)
);
CREATE INDEX IF NOT EXISTS restaurant_riders_customer_idx ON restaurant_riders (customer_id) WHERE status = 'active';
ALTER TABLE restaurant_riders ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS rider_id           uuid REFERENCES restaurant_riders(id) ON DELETE SET NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivered_by_rider uuid REFERENCES restaurant_riders(id) ON DELETE SET NULL;

-- Checks (should return: 5 table names, then 8 status values incl. out_for_delivery)
-- SELECT to_regclass('public.scan_tokens'), to_regclass('public.event_checkins'),
--        to_regclass('public.event_door_staff'), to_regclass('public.restaurant_riders'),
--        (SELECT column_name FROM information_schema.columns WHERE table_name = 'orders' AND column_name = 'delivered_confirmed_by');
-- SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'orders_status_chk';
