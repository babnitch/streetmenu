-- =============================================================================
-- PawaPay payments — schema additions
-- =============================================================================
-- Adds opt-in online payment per restaurant and per-order payment tracking.
--
-- When `restaurants.payment_enabled` is false (the default), customers can
-- only "reserve" an order — `orders.order_type='reservation'` and
-- `orders.payment_status='not_required'`. When true, customers can pay by
-- mobile money via PawaPay; the order then carries `order_type='paid_order'`
-- and the payment status transitions through pending → paid (or failed).
--
-- Idempotent — safe to re-run.
-- =============================================================================

-- ── restaurants ─────────────────────────────────────────────────────────────
ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS payment_enabled    BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS pawapay_merchant_id TEXT;

-- ── orders ──────────────────────────────────────────────────────────────────
-- payment_status defaults to 'not_required' so existing rows + newly inserted
-- rows on payment-disabled restaurants need no extra writes.
-- payment_amount is stored in the smallest local unit (FCFA has no minor unit
-- so it's plain integer FCFA; matches orders.total_price scale).
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'not_required',
  ADD COLUMN IF NOT EXISTS payment_id     TEXT,
  ADD COLUMN IF NOT EXISTS payment_method TEXT,
  ADD COLUMN IF NOT EXISTS payment_amount INTEGER,
  ADD COLUMN IF NOT EXISTS payment_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS order_type     TEXT NOT NULL DEFAULT 'reservation';

-- CHECK constraints — drop-then-add for idempotency.
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_payment_status_chk;
ALTER TABLE orders ADD CONSTRAINT orders_payment_status_chk
  CHECK (payment_status IN ('not_required', 'pending', 'paid', 'failed', 'refunded'));

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_order_type_chk;
ALTER TABLE orders ADD CONSTRAINT orders_order_type_chk
  CHECK (order_type IN ('reservation', 'paid_order'));

-- ── indexes ─────────────────────────────────────────────────────────────────
-- Webhook lookups by PawaPay depositId.
CREATE INDEX IF NOT EXISTS orders_payment_id_idx ON orders (payment_id) WHERE payment_id IS NOT NULL;
-- Admin filtering / vendor revenue queries by payment_status.
CREATE INDEX IF NOT EXISTS orders_payment_status_idx ON orders (payment_status);
