-- =============================================================================
-- Event-scoped vouchers + voucher fields on event reservations
-- Run this in the Supabase SQL Editor BEFORE deploying the code that reads it.
-- =============================================================================
-- Extends the voucher system (previously restaurant-only) to events:
--   • vouchers.event_id set        → valid only for that event
--   • vouchers.restaurant_id set   → restaurant only (existing behaviour)
--   • both NULL                    → platform-wide (events AND restaurants)
-- event_reservations gains voucher_code + discount_amount so a redeemed
-- reservation records what was applied and its final (discounted) total.
-- Idempotent — safe to re-run.
-- =============================================================================

-- 1. vouchers: optional event scope.
ALTER TABLE vouchers
  ADD COLUMN IF NOT EXISTS event_id UUID REFERENCES events(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_vouchers_event_id ON vouchers(event_id);

-- 2. event_reservations: record the redeemed code + discount.
ALTER TABLE event_reservations
  ADD COLUMN IF NOT EXISTS voucher_code    TEXT,
  ADD COLUMN IF NOT EXISTS discount_amount INTEGER NOT NULL DEFAULT 0;
