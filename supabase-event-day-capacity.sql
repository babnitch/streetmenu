-- =============================================================================
-- EVENT DAY CAPACITY — seats per DAY and per TIER
-- -----------------------------------------------------------------------------
-- events.max_tickets and event_ticket_tiers.max_quantity become PER-DAY caps
-- (identical to before for single-day events). Each reservation records the
-- day it is for (event_reservations.event_date).
--
-- Availability is computed from the reservation rows themselves, not from the
-- tickets_sold / sold_count counters, which had drifted. The counters are
-- still maintained as all-days totals for dashboards, but decide nothing.
--
-- A reservation HOLDS seats when reservation_status is pending / confirmed /
-- attended AND payment is not_required or paid, or pending for less than
-- event_payment_hold() (a MoMo prompt in flight). Cancelled, rejected, failed
-- and abandoned payments hold nothing.
--
-- A payment that settles as paid AFTER its hold expired is still confirmed;
-- event_reservation_overflow() then tells the app whether it pushed a day or
-- tier over capacity, so it can be flagged "oversold" (audit + admin panel).
--
-- Every booking goes through reserve_event_seats(), which locks the event row,
-- checks the per-tier and per-event caps for that day, and inserts — so two
-- buyers can no longer both take the last seat.
--
-- Legacy reservations on MULTI-DAY events have no recorded day: they keep
-- event_date NULL and count against EVERY day (never oversells).
--
-- Service-role only. Idempotent. Run BEFORE deploying the code that calls it.
-- =============================================================================

BEGIN;

-- 1. The day a reservation is for --------------------------------------------
ALTER TABLE event_reservations ADD COLUMN IF NOT EXISTS event_date DATE;

-- 2. Backfill: single-day events → their only day (exact) --------------------
UPDATE event_reservations r
   SET event_date = e.date
  FROM events e
 WHERE r.event_id = e.id
   AND r.event_date IS NULL
   AND e.effective_end_date = e.date;

-- 3. Index for per-day / per-tier sums ----------------------------------------
CREATE INDEX IF NOT EXISTS event_reservations_day_tier_idx
  ON event_reservations (event_id, event_date, tier_id)
  WHERE reservation_status IN ('pending', 'confirmed', 'attended');

-- 4. How long an unpaid MoMo prompt holds its seats — the ONE definition ----
CREATE OR REPLACE FUNCTION event_payment_hold()
RETURNS interval
LANGUAGE sql IMMUTABLE
AS $$ SELECT interval '30 minutes' $$;

-- 5. The seat rule — used by every function below ----------------------------
CREATE OR REPLACE FUNCTION event_reservation_holds_seats(
  p_reservation_status text,
  p_payment_status     text,
  p_created_at         timestamptz
) RETURNS boolean
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  SELECT p_reservation_status IN ('pending', 'confirmed', 'attended')
     AND (   p_payment_status IN ('not_required', 'paid')
          OR (p_payment_status = 'pending' AND p_created_at > now() - event_payment_hold()))
$$;

-- 6. Seats held on one day (whole event when p_tier_id is NULL) --------------
CREATE OR REPLACE FUNCTION event_day_sold(
  p_event_id uuid,
  p_day      date,
  p_tier_id  uuid DEFAULT NULL
) RETURNS integer
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(SUM(r.quantity), 0)::integer
    FROM event_reservations r
   WHERE r.event_id = p_event_id
     AND (r.event_date = p_day OR r.event_date IS NULL)
     AND (p_tier_id IS NULL OR r.tier_id = p_tier_id)
     AND event_reservation_holds_seats(r.reservation_status, r.payment_status, r.created_at)
$$;

-- 7. Availability grid: one row per day × (event-wide cap + each active tier) -
--    tier_id NULL = the event-wide cap (max_tickets). capacity 0 = unlimited.
CREATE OR REPLACE FUNCTION event_availability(p_event_id uuid)
RETURNS TABLE (day date, tier_id uuid, capacity integer, sold integer)
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  WITH ev AS (
    SELECT e.id, e.date, e.effective_end_date, COALESCE(e.max_tickets, 0) AS max_tickets
      FROM events e WHERE e.id = p_event_id
  ),
  days AS (
    SELECT gs::date AS d
      FROM ev, generate_series(ev.date, ev.effective_end_date, interval '1 day') AS gs
  ),
  slots AS (
    SELECT NULL::uuid AS slot_tier, ev.max_tickets AS slot_cap FROM ev
    UNION ALL
    SELECT t.id, t.max_quantity
      FROM event_ticket_tiers t
     WHERE t.event_id = p_event_id AND t.is_active
  ),
  held AS (
    SELECT r.event_date AS h_day, r.tier_id AS h_tier, SUM(r.quantity)::integer AS h_qty
      FROM event_reservations r
     WHERE r.event_id = p_event_id
       AND event_reservation_holds_seats(r.reservation_status, r.payment_status, r.created_at)
     GROUP BY r.event_date, r.tier_id
  )
  SELECT days.d, slots.slot_tier, slots.slot_cap,
         COALESCE((SELECT SUM(held.h_qty) FROM held
                    WHERE (held.h_day = days.d OR held.h_day IS NULL)
                      AND (slots.slot_tier IS NULL OR held.h_tier = slots.slot_tier)), 0)::integer
    FROM days CROSS JOIN slots
   ORDER BY days.d, slots.slot_tier NULLS FIRST
$$;

-- 8. Atomic check + insert ---------------------------------------------------
--    p_rows: JSON array, one object per reservation row:
--      { customer_id, customer_name, customer_phone, quantity, total_price,
--        commission_amount, discount_amount, voucher_code, payment_status,
--        payment_id, payment_method, reservation_status, reservation_code,
--        tier_id, tier_name, tier_price }
--    Errors (SQLSTATE P0001; message is the code, DETAIL carries JSON):
--      no_rows · invalid_quantity · event_not_found · invalid_event_date ·
--      past_event_date · tier_unavailable {tier_id} ·
--      tier_sold_out {tier_id, remaining} · event_sold_out {remaining}
CREATE OR REPLACE FUNCTION reserve_event_seats(
  p_event_id   uuid,
  p_event_date date,
  p_rows       jsonb
) RETURNS SETOF event_reservations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_event record;
  v_line  record;
  v_tier  record;
  v_total integer;
  v_held  integer;
BEGIN
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0 THEN
    RAISE EXCEPTION 'no_rows' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_rows) x
              WHERE COALESCE((x->>'quantity')::integer, 0) < 1) THEN
    RAISE EXCEPTION 'invalid_quantity' USING ERRCODE = 'P0001';
  END IF;

  -- Serialises every booking on this event until COMMIT.
  SELECT e.id, e.date, e.effective_end_date, COALESCE(e.max_tickets, 0) AS max_tickets
    INTO v_event
    FROM events e WHERE e.id = p_event_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'event_not_found' USING ERRCODE = 'P0001';
  END IF;

  IF p_event_date IS NULL OR p_event_date < v_event.date OR p_event_date > v_event.effective_end_date THEN
    RAISE EXCEPTION 'invalid_event_date' USING ERRCODE = 'P0001';
  END IF;
  -- "Today" is the UTC date, as in lib/eventDate.ts.
  IF p_event_date < (now() AT TIME ZONE 'UTC')::date THEN
    RAISE EXCEPTION 'past_event_date' USING ERRCODE = 'P0001';
  END IF;

  SELECT SUM((x->>'quantity')::integer)::integer INTO v_total
    FROM jsonb_array_elements(p_rows) x;

  -- Per-tier cap on that day.
  FOR v_line IN
    SELECT (x->>'tier_id')::uuid AS line_tier, SUM((x->>'quantity')::integer)::integer AS line_qty
      FROM jsonb_array_elements(p_rows) x
     WHERE x->>'tier_id' IS NOT NULL
     GROUP BY 1
  LOOP
    SELECT t.id, t.max_quantity, t.is_active INTO v_tier
      FROM event_ticket_tiers t
     WHERE t.id = v_line.line_tier AND t.event_id = p_event_id;
    IF NOT FOUND OR NOT v_tier.is_active THEN
      RAISE EXCEPTION 'tier_unavailable' USING ERRCODE = 'P0001',
        DETAIL = json_build_object('tier_id', v_line.line_tier)::text;
    END IF;
    IF v_tier.max_quantity > 0 THEN
      v_held := event_day_sold(p_event_id, p_event_date, v_line.line_tier);
      IF v_held + v_line.line_qty > v_tier.max_quantity THEN
        RAISE EXCEPTION 'tier_sold_out' USING ERRCODE = 'P0001',
          DETAIL = json_build_object('tier_id', v_line.line_tier,
                                     'remaining', GREATEST(0, v_tier.max_quantity - v_held))::text;
      END IF;
    END IF;
  END LOOP;

  -- Event-wide cap on that day.
  IF v_event.max_tickets > 0 THEN
    v_held := event_day_sold(p_event_id, p_event_date, NULL);
    IF v_held + v_total > v_event.max_tickets THEN
      RAISE EXCEPTION 'event_sold_out' USING ERRCODE = 'P0001',
        DETAIL = json_build_object('remaining', GREATEST(0, v_event.max_tickets - v_held))::text;
    END IF;
  END IF;

  -- All-days counters, kept for dashboards only.
  UPDATE events e
     SET tickets_sold = COALESCE(e.tickets_sold, 0) + v_total
   WHERE e.id = p_event_id;
  UPDATE event_ticket_tiers t
     SET sold_count = t.sold_count + l.line_qty, updated_at = now()
    FROM (SELECT (x->>'tier_id')::uuid AS line_tier, SUM((x->>'quantity')::integer)::integer AS line_qty
            FROM jsonb_array_elements(p_rows) x
           WHERE x->>'tier_id' IS NOT NULL
           GROUP BY 1) l
   WHERE t.id = l.line_tier;

  RETURN QUERY
  WITH ins AS (
    INSERT INTO event_reservations (
      event_id, event_date,
      customer_id, customer_name, customer_phone,
      quantity, total_price, commission_amount, discount_amount, voucher_code,
      payment_status, payment_id, payment_method,
      reservation_status, reservation_code,
      tier_id, tier_name, tier_price
    )
    SELECT p_event_id, p_event_date,
           r.customer_id, r.customer_name, r.customer_phone,
           r.quantity,
           COALESCE(r.total_price, 0), COALESCE(r.commission_amount, 0),
           COALESCE(r.discount_amount, 0), r.voucher_code,
           COALESCE(r.payment_status, 'not_required'), r.payment_id, r.payment_method,
           COALESCE(r.reservation_status, 'confirmed'), r.reservation_code,
           r.tier_id, r.tier_name, r.tier_price
      FROM jsonb_to_recordset(p_rows) AS r(
             customer_id        uuid,
             customer_name      text,
             customer_phone     text,
             quantity           integer,
             total_price        integer,
             commission_amount  integer,
             discount_amount    integer,
             voucher_code       text,
             payment_status     text,
             payment_id         text,
             payment_method     text,
             reservation_status text,
             reservation_code   text,
             tier_id            uuid,
             tier_name          text,
             tier_price         integer)
    RETURNING *
  )
  SELECT * FROM ins;
END
$$;

-- 9. Oversold check for a payment that settled after its hold expired -------
--    Returns the day/slot rows (tier_id NULL = event-wide cap) where seats
--    held now exceed capacity — empty when the reservation was still within
--    its hold (it was counted all along, so it cannot have overflowed
--    anything) or when nothing is over. A NULL event_date (legacy multi-day)
--    is checked on every day of the event.
CREATE OR REPLACE FUNCTION event_reservation_overflow(p_reservation_id uuid)
RETURNS TABLE (day date, tier_id uuid, capacity integer, sold integer)
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  WITH r AS (
    SELECT res.event_id, res.event_date, res.tier_id AS r_tier
      FROM event_reservations res
     WHERE res.id = p_reservation_id
       AND res.created_at <= now() - event_payment_hold()
  )
  SELECT a.day, a.tier_id, a.capacity, a.sold
    FROM r
    CROSS JOIN LATERAL event_availability(r.event_id) a
   WHERE (r.event_date IS NULL OR a.day = r.event_date)
     AND (a.tier_id IS NULL OR a.tier_id = r.r_tier)
     AND a.capacity > 0
     AND a.sold > a.capacity
$$;

-- 10. Grants: service role only (Supabase grants new functions to anon /
--     authenticated by default — take that back explicitly).
REVOKE ALL ON FUNCTION event_payment_hold()                                   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION event_reservation_holds_seats(text, text, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION event_day_sold(uuid, date, uuid)                       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION event_availability(uuid)                               FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION reserve_event_seats(uuid, date, jsonb)                 FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION event_reservation_overflow(uuid)                       FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION event_payment_hold()                                   TO service_role;
GRANT EXECUTE ON FUNCTION event_reservation_holds_seats(text, text, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION event_day_sold(uuid, date, uuid)                       TO service_role;
GRANT EXECUTE ON FUNCTION event_availability(uuid)                               TO service_role;
GRANT EXECUTE ON FUNCTION reserve_event_seats(uuid, date, jsonb)                 TO service_role;
GRANT EXECUTE ON FUNCTION event_reservation_overflow(uuid)                       TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- ── Verify ───────────────────────────────────────────────────────────────────
--   SELECT count(*) FILTER (WHERE event_date IS NULL) AS no_day, count(*) AS total
--     FROM event_reservations;            -- no_day = legacy multi-day rows only
--   SELECT * FROM event_availability('66ad378e-3e8b-4b8a-9c1e-091c87df7e95');
--     -- one row per day × slot; the 17 legacy seats show on every day
--   SELECT has_function_privilege('anon', 'reserve_event_seats(uuid,date,jsonb)', 'EXECUTE');  -- false
