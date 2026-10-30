ALTER TABLE orders ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION is_test_order(p_order uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM orders o LEFT JOIN restaurants r ON r.id = o.restaurant_id
     WHERE o.id = p_order
       AND (o.is_test OR o.customer_phone LIKE '+999%' OR r.city LIKE '\_\_t\_%' OR r.whatsapp LIKE '+999%'))
$$;

CREATE OR REPLACE FUNCTION ledger_post(p_movement text, p_kind text, p_lines jsonb, p_by uuid DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE l jsonb; i smallint := 0; t boolean := false;
BEGIN
  IF EXISTS (SELECT 1 FROM money_ledger WHERE movement = p_movement) THEN RETURN false; END IF;
  FOR l IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    IF (NULLIF(l->>'order_id', '') IS NOT NULL AND is_test_order((l->>'order_id')::uuid))
       OR (NULLIF(l->>'payout_id', '') IS NOT NULL AND EXISTS (SELECT 1 FROM pro_payouts WHERE id = (l->>'payout_id')::uuid AND is_test))
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
    RETURN false;
  END;
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION payout_post(p_payout uuid, p_phase text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE p pro_payouts;
BEGIN
  SELECT * INTO p FROM pro_payouts WHERE id = p_payout FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF p_phase = 'started' THEN
    IF (SELECT COALESCE(SUM(delta), 0) FROM money_ledger
         WHERE party_type = p.party_type AND party_id = p.party_id AND bucket = 'available' AND is_test = p.is_test) < p.amount
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

REVOKE ALL ON FUNCTION is_test_order(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION ledger_post(text, text, jsonb, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION payout_post(uuid, text) FROM PUBLIC, anon, authenticated;

SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'is_test';
