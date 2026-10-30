-- Prompt R — refunds (R2) and payout tests (R3). Safe to re-run.
--
-- refunds: one row per PawaPay refund. id IS the PawaPay refundId, written
-- BEFORE the API call. start_refund() and settle_refund() do every check and
-- transition in one transaction, so two clicks / a callback racing the cron
-- can never refund twice or over the amount paid.

CREATE TABLE IF NOT EXISTS refunds (
  id             uuid PRIMARY KEY,
  kind           text NOT NULL CHECK (kind IN ('order', 'reservation')),
  order_id       uuid REFERENCES orders(id) ON DELETE SET NULL,
  reservation_id uuid REFERENCES event_reservations(id) ON DELETE SET NULL,
  deposit_id     text NOT NULL,
  amount         integer NOT NULL CHECK (amount > 0),
  currency       text NOT NULL DEFAULT 'XAF',
  reason         text NOT NULL,
  cancel_after   boolean NOT NULL DEFAULT false,
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed')),
  pawapay_status text,
  failure_reason text,
  requested_by   uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  completed_at   timestamptz
);
-- One refund in progress per payment.
CREATE UNIQUE INDEX IF NOT EXISTS refunds_one_pending_per_deposit ON refunds (deposit_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS refunds_status_created_idx ON refunds (status, created_at);
CREATE INDEX IF NOT EXISTS refunds_order_idx ON refunds (order_id);
CREATE INDEX IF NOT EXISTS refunds_reservation_idx ON refunds (reservation_id);
ALTER TABLE refunds ENABLE ROW LEVEL SECURITY;

ALTER TABLE orders ADD COLUMN IF NOT EXISTS refund_status text NOT NULL DEFAULT 'none';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS refunded_amount integer NOT NULL DEFAULT 0;
ALTER TABLE event_reservations ADD COLUMN IF NOT EXISTS refund_status text NOT NULL DEFAULT 'none';
ALTER TABLE event_reservations ADD COLUMN IF NOT EXISTS refunded_amount integer NOT NULL DEFAULT 0;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_refund_status_chk;
ALTER TABLE orders ADD CONSTRAINT orders_refund_status_chk CHECK (refund_status IN ('none', 'pending', 'partial', 'refunded'));
ALTER TABLE event_reservations DROP CONSTRAINT IF EXISTS event_reservations_refund_status_chk;
ALTER TABLE event_reservations ADD CONSTRAINT event_reservations_refund_status_chk CHECK (refund_status IN ('none', 'pending', 'partial', 'refunded'));

-- start_refund: checks + the pending row, atomically. Raises:
--   not_found / not_paid / no_deposit / refund_in_progress / over_amount
CREATE OR REPLACE FUNCTION start_refund(
  p_id uuid, p_kind text, p_target uuid, p_amount integer, p_reason text, p_cancel boolean, p_admin uuid
) RETURNS refunds LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_paid integer; v_status text; v_deposit text; v_done integer; v_row refunds;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'bad_amount'; END IF;
  IF p_kind = 'order' THEN
    SELECT COALESCE(payment_amount, ROUND(total_price)::int), payment_status, payment_id, refunded_amount
      INTO v_paid, v_status, v_deposit, v_done
      FROM orders WHERE id = p_target FOR UPDATE;
  ELSIF p_kind = 'reservation' THEN
    SELECT ROUND(total_price)::int, payment_status, payment_id, refunded_amount
      INTO v_paid, v_status, v_deposit, v_done
      FROM event_reservations WHERE id = p_target FOR UPDATE;
  ELSE
    RAISE EXCEPTION 'bad_kind';
  END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
  IF v_status NOT IN ('paid', 'refunded') THEN RAISE EXCEPTION 'not_paid'; END IF;
  IF v_deposit IS NULL THEN RAISE EXCEPTION 'no_deposit'; END IF;
  IF EXISTS (SELECT 1 FROM refunds WHERE deposit_id = v_deposit AND status = 'pending') THEN
    RAISE EXCEPTION 'refund_in_progress';
  END IF;
  IF COALESCE(v_done, 0) + p_amount > v_paid THEN
    RAISE EXCEPTION 'over_amount' USING DETAIL = json_build_object('paid', v_paid, 'refunded', COALESCE(v_done, 0))::text;
  END IF;

  INSERT INTO refunds (id, kind, order_id, reservation_id, deposit_id, amount, reason, cancel_after, requested_by)
  VALUES (p_id, p_kind,
          CASE WHEN p_kind = 'order' THEN p_target END,
          CASE WHEN p_kind = 'reservation' THEN p_target END,
          v_deposit, p_amount, p_reason, COALESCE(p_cancel, false), p_admin)
  RETURNING * INTO v_row;

  IF p_kind = 'order' THEN
    UPDATE orders SET refund_status = 'pending' WHERE id = p_target;
  ELSE
    UPDATE event_reservations SET refund_status = 'pending' WHERE id = p_target;
  END IF;
  RETURN v_row;
END $$;

-- settle_refund: pending → completed | failed, once. Returns the row only to
-- the caller that won (others get NULL). Completed: adds the amount to
-- refunded_amount; refund_status = refunded (all paid back) or partial. A
-- full order refund also sets payment_status = 'refunded'. Failed: the
-- target's refund_status goes back to what the completed refunds say.
CREATE OR REPLACE FUNCTION settle_refund(p_id uuid, p_status text, p_pawapay_status text, p_failure text)
RETURNS refunds LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_row refunds; v_paid integer; v_done integer;
BEGIN
  IF p_status NOT IN ('completed', 'failed') THEN RAISE EXCEPTION 'bad_status'; END IF;
  UPDATE refunds SET status = p_status, pawapay_status = p_pawapay_status, failure_reason = p_failure,
                     updated_at = now(), completed_at = CASE WHEN p_status = 'completed' THEN now() END
   WHERE id = p_id AND status = 'pending'
  RETURNING * INTO v_row;
  IF NOT FOUND THEN RETURN NULL; END IF;

  IF v_row.kind = 'order' THEN
    SELECT COALESCE(payment_amount, ROUND(total_price)::int), refunded_amount INTO v_paid, v_done
      FROM orders WHERE id = v_row.order_id FOR UPDATE;
    IF p_status = 'completed' THEN v_done := COALESCE(v_done, 0) + v_row.amount; END IF;
    UPDATE orders SET
      refunded_amount = COALESCE(v_done, 0),
      refund_status   = CASE WHEN COALESCE(v_done, 0) >= v_paid THEN 'refunded'
                             WHEN COALESCE(v_done, 0) > 0 THEN 'partial' ELSE 'none' END,
      payment_status  = CASE WHEN COALESCE(v_done, 0) >= v_paid THEN 'refunded' ELSE payment_status END
     WHERE id = v_row.order_id;
  ELSE
    SELECT ROUND(total_price)::int, refunded_amount INTO v_paid, v_done
      FROM event_reservations WHERE id = v_row.reservation_id FOR UPDATE;
    IF p_status = 'completed' THEN v_done := COALESCE(v_done, 0) + v_row.amount; END IF;
    UPDATE event_reservations SET
      refunded_amount = COALESCE(v_done, 0),
      refund_status   = CASE WHEN COALESCE(v_done, 0) >= v_paid THEN 'refunded'
                             WHEN COALESCE(v_done, 0) > 0 THEN 'partial' ELSE 'none' END
     WHERE id = v_row.reservation_id;
  END IF;
  RETURN v_row;
END $$;

REVOKE ALL ON FUNCTION start_refund(uuid, text, uuid, integer, text, boolean, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION settle_refund(uuid, text, text, text) FROM PUBLIC, anon, authenticated;

-- R3 — admin payout tests (small amounts to a number the super admin types).
CREATE TABLE IF NOT EXISTS payout_tests (
  id             uuid PRIMARY KEY,          -- the PawaPay payoutId
  phone          text NOT NULL,
  correspondent  text,
  amount         integer NOT NULL CHECK (amount > 0),
  currency       text NOT NULL DEFAULT 'XAF',
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed')),
  pawapay_status text,
  failure_reason text,
  requested_by   uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  completed_at   timestamptz
);
ALTER TABLE payout_tests ENABLE ROW LEVEL SECURITY;

-- Checks (expect: 2 tables, 4 columns, 2 functions)
-- SELECT to_regclass('public.refunds'), to_regclass('public.payout_tests');
-- SELECT table_name, column_name FROM information_schema.columns WHERE column_name IN ('refund_status','refunded_amount');
-- SELECT proname FROM pg_proc WHERE proname IN ('start_refund','settle_refund');
