-- ── Broadcast capability (admin opt-in) ──────────────────────────────────────
-- Paid city broadcasts used to be open to anyone who had one event approved
-- or owned an approved restaurant. They are now an admin-granted capability,
-- OFF by default:
--
--   restaurants.broadcast_enabled — the restaurant may be used as a sender
--                                   (sender_type = 'restaurant')
--   customers.broadcast_enabled   — the account may broadcast as an event
--                                   publisher (sender_type = 'publisher')
--
-- Publisher broadcasts are not tied to an event (broadcasts has no event_id),
-- so the publisher flag lives on the customer, next to event_auto_approve.
-- customers.broadcast_blocked still overrides both flags.
--
-- No backfill: every existing sender starts disabled and is re-enabled by an
-- admin in /admin/restaurants or /admin/accounts.
--
-- Run BEFORE deploying the code that reads these columns. Idempotent.

ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS broadcast_enabled boolean NOT NULL DEFAULT false;

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS broadcast_enabled boolean NOT NULL DEFAULT false;

NOTIFY pgrst, 'reload schema';

-- Verify:
--   SELECT column_name, data_type, column_default, is_nullable
--     FROM information_schema.columns
--    WHERE column_name = 'broadcast_enabled'
--      AND table_name IN ('restaurants', 'customers');
--   -- expect 2 rows: boolean, false, NO
--
-- In-flight broadcasts that the send-time check would now refuse:
--   SELECT id, sender_id, sender_type, restaurant_id, status, payment_status, created_at
--     FROM broadcasts WHERE status IN ('draft', 'paid', 'sending');
