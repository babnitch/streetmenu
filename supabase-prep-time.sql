-- =============================================================================
-- Restaurant preparation time + order timing columns
-- Run this in Supabase SQL Editor
-- =============================================================================
-- prep_time_min/max drive the "🕐 20-35 min" badge across cards, the
-- detail page, and order confirmations. orders.confirmed_at/ready_at are
-- added now (populated by the status route) so a future rolling-average
-- "smart estimate" has historical data to work from — no calculation is
-- built yet.
-- Idempotent — safe to re-run.
-- =============================================================================

-- 1. restaurants: prep time range ---------------------------------------------
ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS prep_time_min INTEGER,
  ADD COLUMN IF NOT EXISTS prep_time_max INTEGER;

-- Seed a sensible default for every restaurant that hasn't set one.
-- Only touches NULL rows so a vendor's custom value is never overwritten
-- on a re-run.
UPDATE restaurants
   SET prep_time_min = 20, prep_time_max = 35
 WHERE prep_time_min IS NULL;

-- 2. orders: confirm/ready timestamps (Part 4 groundwork) ---------------------
-- Populated by /api/orders/[id]/status when the vendor flips an order to
-- confirmed / ready. actual_prep_time = ready_at - confirmed_at later.
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ready_at     TIMESTAMPTZ;
