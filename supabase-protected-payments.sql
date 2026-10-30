-- Prompt P — protected payments (module "payments_protected", OFF by default).
-- Built now: P1 (hold / release / automatic refund / problem) + minimal P2
-- (ledger, payouts). Data model ready, NOT built yet: P2b riders, P3 events,
-- P4 deposits. Safe to re-run. Nothing here changes today's behaviour: every
-- new column is NULL / 0 for existing rows, every switch starts OFF.
-- Test data (fake test city "__t_…", +999 numbers) is flagged is_test and
-- excluded from every balance.

-- ── 1. Orders: where the money is ───────────────────────────────────────────
ALTER TABLE orders ADD COLUMN IF NOT EXISTS funds_status text;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_funds_status_chk;
ALTER TABLE orders ADD CONSTRAINT orders_funds_status_chk
  CHECK (funds_status IS NULL OR funds_status IN ('held', 'released', 'refunding', 'refunded', 'disputed'));
ALTER TABLE orders ADD COLUMN IF NOT EXISTS funds_held_at       timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS funds_released_at   timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS funds_released_by   text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS accept_deadline     timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS release_attempts    smallint NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS release_locked_at   timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS commission_amount   integer NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS deposit_amount      integer;
CREATE INDEX IF NOT EXISTS orders_funds_status_idx ON orders (funds_status) WHERE funds_status IS NOT NULL;

ALTER TABLE event_reservations ADD COLUMN IF NOT EXISTS funds_status      text;
ALTER TABLE event_reservations DROP CONSTRAINT IF EXISTS event_reservations_funds_status_chk;
ALTER TABLE event_reservations ADD CONSTRAINT event_reservations_funds_status_chk
  CHECK (funds_status IS NULL OR funds_status IN ('held', 'released', 'refunding', 'refunded', 'disputed'));
ALTER TABLE event_reservations ADD COLUMN IF NOT EXISTS funds_released_at timestamptz;
ALTER TABLE event_reservations ADD COLUMN IF NOT EXISTS deposit_amount    integer;

-- Where a pro is paid. NULL = their WhatsApp number. A change by the pro
-- waits in payout_phone_pending until an admin confirms it.
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS payout_phone         text;
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS payout_phone_pending text;
ALTER TABLE customers   ADD COLUMN IF NOT EXISTS payout_phone         text;
ALTER TABLE customers   ADD COLUMN IF NOT EXISTS payout_phone_pending text;

-- ── 2. Problems reported by a customer ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS order_problems (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  reported_by   uuid REFERENCES customers(id) ON DELETE SET NULL,
  via           text NOT NULL DEFAULT 'web' CHECK (via IN ('web', 'whatsapp')),
  reason        text NOT NULL,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'released', 'refunded', 'partly_refunded')),
  resolved_by   uuid,
  resolved_at   timestamptz,
  refund_id     uuid,
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS order_problems_one_open ON order_problems (order_id) WHERE status = 'open';
ALTER TABLE order_problems ENABLE ROW LEVEL SECURITY;

-- ── 3. Is it test data? (fake test city "__t_…" or a +999 number) ──────────
CREATE OR REPLACE FUNCTION is_test_party(p_type text, p_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE
    WHEN p_id IS NULL THEN false
    WHEN p_type = 'restaurant' THEN EXISTS (SELECT 1 FROM restaurants
      WHERE id = p_id AND (city LIKE '\_\_t\_%' OR whatsapp LIKE '+999%'))
    ELSE EXISTS (SELECT 1 FROM customers
      WHERE id = p_id AND (phone LIKE '+999%' OR city LIKE '\_\_t\_%'))
  END
$$;

CREATE OR REPLACE FUNCTION is_test_order(p_order uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM orders o LEFT JOIN restaurants r ON r.id = o.restaurant_id
     WHERE o.id = p_order
       AND (o.customer_phone LIKE '+999%' OR r.city LIKE '\_\_t\_%' OR r.whatsapp LIKE '+999%'))
$$;

-- ── 4. The ledger: append-only ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS money_ledger (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  movement       text NOT NULL,
  line           smallint NOT NULL,
  kind           text NOT NULL,
  party_type     text NOT NULL CHECK (party_type IN ('restaurant', 'organizer', 'rider', 'platform', 'customer')),
  party_id       uuid,
  bucket         text NOT NULL CHECK (bucket IN ('held', 'available', 'in_transit', 'paid_out', 'revenue', 'refunded', 'fees')),
  delta          integer NOT NULL,
  order_id       uuid,
  reservation_id uuid,
  refund_id      uuid,
  payout_id      uuid,
  note           text,
  is_test        boolean NOT NULL DEFAULT false,
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (movement, line)
);
ALTER TABLE money_ledger ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS money_ledger_party_idx ON money_ledger (party_type, party_id, bucket);
CREATE INDEX IF NOT EXISTS money_ledger_order_idx ON money_ledger (order_id);
CREATE INDEX IF NOT EXISTS money_ledger_real_idx  ON money_ledger (party_type, bucket) WHERE NOT is_test;
ALTER TABLE money_ledger ENABLE ROW LEVEL SECURITY;
CREATE OR REPLACE FUNCTION money_ledger_no_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'money_ledger is append-only'; END $$;
DROP TRIGGER IF EXISTS money_ledger_append_only ON money_ledger;
CREATE TRIGGER money_ledger_append_only BEFORE UPDATE OR DELETE ON money_ledger
  FOR EACH ROW EXECUTE FUNCTION money_ledger_no_change();

-- Real balances only (test lines never count).
CREATE OR REPLACE VIEW money_balances WITH (security_invoker = true) AS
  SELECT party_type, party_id, bucket, SUM(delta)::bigint AS amount
  FROM money_ledger WHERE NOT is_test GROUP BY party_type, party_id, bucket;
REVOKE ALL ON money_balances FROM anon, authenticated;

-- ── 5. Payouts to pros (one per pro per day) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS pro_payouts (
  id             uuid PRIMARY KEY,
  party_type     text NOT NULL CHECK (party_type IN ('restaurant', 'organizer', 'rider')),
  party_id       uuid NOT NULL,
  amount         integer NOT NULL CHECK (amount > 0),
  phone          text NOT NULL,
  day            date NOT NULL,
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed')),
  pawapay_status text,
  failure_reason text,
  is_test        boolean NOT NULL DEFAULT false,
  requested_by   uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  completed_at   timestamptz
);
ALTER TABLE pro_payouts ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS pro_payouts_one_per_day ON pro_payouts (party_type, party_id, day) WHERE status <> 'failed';
ALTER TABLE pro_payouts ENABLE ROW LEVEL SECURITY;

-- is_test set automatically from the pro (or the phone paid).
CREATE OR REPLACE FUNCTION pro_payouts_flag_test() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.is_test := NEW.is_test OR is_test_party(NEW.party_type, NEW.party_id) OR NEW.phone LIKE '+999%';
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS pro_payouts_is_test ON pro_payouts;
CREATE TRIGGER pro_payouts_is_test BEFORE INSERT ON pro_payouts
  FOR EACH ROW EXECUTE FUNCTION pro_payouts_flag_test();

-- ── 6. Settings ──────────────────────────────────────────────────────────────
INSERT INTO platform_settings (key, value) VALUES
  ('payments_protected_master',      'false'::jsonb),
  ('protected_accept_timeout_min',   '15'::jsonb),
  ('protected_auto_release_hours',   '24'::jsonb),
  ('protected_code_max_tries',       '5'::jsonb),
  ('commission_order_pct',           '0'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ── 7. The money moves (claim + ledger, one transaction, once) ──────────────
-- ledger_post writes a movement's lines once. A second caller (or a
-- concurrent one hitting the unique key) gets FALSE, never an error.
-- is_test is set for the whole movement when any line's order or party is
-- test data.
CREATE OR REPLACE FUNCTION ledger_post(p_movement text, p_kind text, p_lines jsonb, p_by uuid DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE l jsonb; i smallint := 0; t boolean := false;
BEGIN
  IF EXISTS (SELECT 1 FROM money_ledger WHERE movement = p_movement) THEN RETURN false; END IF;
  FOR l IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    IF (NULLIF(l->>'order_id', '') IS NOT NULL AND is_test_order((l->>'order_id')::uuid))
       OR is_test_party(l->>'party_type', NULLIF(l->>'party_id', '')::uuid) THEN t := true; END IF;
  END LOOP;
  BEGIN
    FOR l IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
      i := i + 1;
      INSERT INTO money_ledger (movement, line, kind, party_type, party_id, bucket, delta, order_id, reservation_id, refund_id, payout_id, note, is_test, created_by)
      VALUES (p_movement, i, p_kind, l->>'party_type', NULLIF(l->>'party_id', '')::uuid, l->>'bucket', (l->>'delta')::int,
              NULLIF(l->>'order_id', '')::uuid, NULLIF(l->>'reservation_id', '')::uuid, NULLIF(l->>'refund_id', '')::uuid,
              NULLIF(l->>'payout_id', '')::uuid, l->>'note', t, p_by);
    END LOOP;
  EXCEPTION WHEN unique_violation THEN
    RETURN false;   -- a concurrent caller posted it first; its lines stand
  END;
  RETURN true;
END $$;

-- Payment completed on a protected order → held for the restaurant.
CREATE OR REPLACE FUNCTION order_funds_hold(p_order uuid, p_amount integer, p_deadline timestamptz)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r uuid;
BEGIN
  UPDATE orders SET funds_status = 'held', funds_held_at = now(), accept_deadline = p_deadline
   WHERE id = p_order AND funds_status IS NULL AND payment_status = 'paid'
  RETURNING restaurant_id INTO r;
  IF NOT FOUND THEN RETURN false; END IF;
  IF NOT ledger_post('held:order:' || p_order, 'payment_held',
    jsonb_build_array(jsonb_build_object('party_type', 'restaurant', 'party_id', r, 'bucket', 'held', 'delta', p_amount, 'order_id', p_order))) THEN
    RAISE EXCEPTION 'hold_already_posted';   -- undo the claim: never a held order without its line
  END IF;
  RETURN true;
END $$;

-- Release (code, customer, auto, admin): what is still held → available,
-- minus the commission → platform revenue.
CREATE OR REPLACE FUNCTION order_funds_release(p_order uuid, p_by text, p_commission integer, p_actor uuid DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r uuid; held bigint; c integer;
BEGIN
  UPDATE orders SET funds_status = 'released', funds_released_at = now(), funds_released_by = p_by
   WHERE id = p_order AND funds_status IN ('held', 'disputed')
  RETURNING restaurant_id INTO r;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT COALESCE(SUM(delta), 0) INTO held FROM money_ledger WHERE order_id = p_order AND party_type = 'restaurant' AND bucket = 'held';
  c := LEAST(GREATEST(COALESCE(p_commission, 0), 0), held);
  UPDATE orders SET commission_amount = c WHERE id = p_order;
  IF NOT ledger_post('release:order:' || p_order, 'released', jsonb_build_array(
    jsonb_build_object('party_type', 'restaurant', 'party_id', r, 'bucket', 'held', 'delta', -held, 'order_id', p_order),
    jsonb_build_object('party_type', 'restaurant', 'party_id', r, 'bucket', 'available', 'delta', held - c, 'order_id', p_order),
    jsonb_build_object('party_type', 'platform', 'bucket', 'revenue', 'delta', c, 'order_id', p_order, 'note', 'commission')
  ), p_actor) THEN
    RAISE EXCEPTION 'release_already_posted';
  END IF;
  RETURN true;
END $$;

-- A refund of a protected order COMPLETED (PawaPay): held → back to the
-- customer. Full → 'refunded'. Partial → 'disputed', so the rest can still
-- be released by an admin (never left in 'refunding').
CREATE OR REPLACE FUNCTION order_funds_refunded(p_order uuid, p_refund uuid, p_amount integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r uuid; held bigint;
BEGIN
  SELECT restaurant_id INTO r FROM orders WHERE id = p_order AND funds_status IN ('held', 'disputed', 'refunding') FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT COALESCE(SUM(delta), 0) INTO held FROM money_ledger WHERE order_id = p_order AND party_type = 'restaurant' AND bucket = 'held';
  IF p_amount <= 0 OR p_amount > held THEN RAISE EXCEPTION 'refund_over_held'; END IF;
  IF NOT ledger_post('refund:' || p_refund, 'refund', jsonb_build_array(
    jsonb_build_object('party_type', 'restaurant', 'party_id', r, 'bucket', 'held', 'delta', -p_amount, 'order_id', p_order, 'refund_id', p_refund),
    jsonb_build_object('party_type', 'customer', 'bucket', 'refunded', 'delta', p_amount, 'order_id', p_order, 'refund_id', p_refund))) THEN
    RETURN false;   -- this refund was already posted
  END IF;
  UPDATE orders SET funds_status = CASE WHEN p_amount = held THEN 'refunded' ELSE 'disputed' END WHERE id = p_order;
  RETURN true;
END $$;

-- Payouts: started (available → in transit), completed (→ paid out),
-- failed (back to available). Each phase once.
CREATE OR REPLACE FUNCTION payout_post(p_payout uuid, p_phase text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE p pro_payouts;
BEGIN
  SELECT * INTO p FROM pro_payouts WHERE id = p_payout FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF p_phase = 'started' THEN
    IF (SELECT COALESCE(SUM(delta), 0) FROM money_ledger WHERE party_type = p.party_type AND party_id = p.party_id AND bucket = 'available') < p.amount
      THEN RAISE EXCEPTION 'payout_over_available'; END IF;
    RETURN ledger_post('payout:' || p_payout || ':started', 'payout_started', jsonb_build_array(
      jsonb_build_object('party_type', p.party_type, 'party_id', p.party_id, 'bucket', 'available',  'delta', -p.amount, 'payout_id', p_payout),
      jsonb_build_object('party_type', p.party_type, 'party_id', p.party_id, 'bucket', 'in_transit', 'delta',  p.amount, 'payout_id', p_payout)), p.requested_by);
  ELSIF p_phase IN ('completed', 'failed') THEN
    UPDATE pro_payouts SET status = p_phase, completed_at = CASE WHEN p_phase = 'completed' THEN now() END
     WHERE id = p_payout AND status = 'pending';
    IF NOT FOUND THEN RETURN false; END IF;
    IF NOT ledger_post('payout:' || p_payout || ':' || p_phase, 'payout_' || p_phase, jsonb_build_array(
      jsonb_build_object('party_type', p.party_type, 'party_id', p.party_id, 'bucket', 'in_transit', 'delta', -p.amount, 'payout_id', p_payout),
      jsonb_build_object('party_type', p.party_type, 'party_id', p.party_id, 'bucket', CASE WHEN p_phase = 'completed' THEN 'paid_out' ELSE 'available' END, 'delta', p.amount, 'payout_id', p_payout))) THEN
      RAISE EXCEPTION 'payout_phase_already_posted';
    END IF;
    RETURN true;
  END IF;
  RAISE EXCEPTION 'bad_phase';
END $$;

REVOKE ALL ON FUNCTION is_test_party(text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION is_test_order(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION ledger_post(text, text, jsonb, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION order_funds_hold(uuid, integer, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION order_funds_release(uuid, text, integer, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION order_funds_refunded(uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION payout_post(uuid, text) FROM PUBLIC, anon, authenticated;

-- Checks:
-- SELECT to_regclass('public.money_ledger'), to_regclass('public.pro_payouts'), to_regclass('public.order_problems');
-- SELECT key, value FROM platform_settings WHERE key LIKE 'protected_%' OR key IN ('payments_protected_master', 'commission_order_pct');
