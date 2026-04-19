-- =============================================================================
-- Voucher system — schema prereqs + welcome voucher seed
-- =============================================================================
-- 1. Adds per_customer_max to vouchers (default 1 = one use per customer).
-- 2. Seeds the BIENVENUE voucher so new-customer auto-claim has something
--    to point at.
--
-- Idempotent — safe to re-run.
-- =============================================================================

ALTER TABLE vouchers
  ADD COLUMN IF NOT EXISTS per_customer_max INTEGER NOT NULL DEFAULT 1;

-- Seed the welcome voucher. ON CONFLICT DO NOTHING so re-running doesn't
-- reset its usage counters.
INSERT INTO vouchers (
  code, discount_type, discount_value, min_order, max_uses, current_uses,
  is_active, active, expires_at, city, restaurant_id, per_customer_max
)
VALUES (
  'BIENVENUE', 'percent', 10, 0, NULL, 0,
  TRUE, TRUE, NULL, NULL, NULL, 1
)
ON CONFLICT (code) DO NOTHING;
