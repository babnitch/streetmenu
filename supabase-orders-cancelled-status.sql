-- =============================================================================
-- WhatsApp ordering — schema prerequisites
-- =============================================================================
-- Two CHECK constraints need widening so the ordering flow can write rows:
--
-- 1. orders_status_chk (originally 'orders_status_check' when created inline
--    on CREATE TABLE) — adds 'cancelled' so vendors can cancel via WhatsApp.
-- 2. signup_sessions_user_type_check — adds 'ordering' so the mid-flow
--    ordering state machine can persist. Also includes 'restaurant_select'
--    which the multi-restaurant vendor selector was already using.
--
-- Idempotent — safe to re-run.
-- =============================================================================

-- ── orders.status ───────────────────────────────────────────────────────────
-- Two possible historical names, depending on whether the constraint was
-- created inline on CREATE TABLE (`orders_status_check`) or via the explicit
-- ADD CONSTRAINT in supabase-optimization.sql (`orders_status_chk`).
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_chk;

ALTER TABLE orders ADD CONSTRAINT orders_status_chk
  CHECK (status IN ('pending', 'confirmed', 'preparing', 'ready', 'completed', 'cancelled'));

-- ── signup_sessions.user_type ───────────────────────────────────────────────
ALTER TABLE signup_sessions DROP CONSTRAINT IF EXISTS signup_sessions_user_type_check;

ALTER TABLE signup_sessions ADD CONSTRAINT signup_sessions_user_type_check
  CHECK (user_type IN ('customer', 'vendor', 'photo_update', 'restaurant_select', 'ordering'));
