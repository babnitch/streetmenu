-- =============================================================================
-- Vendor order-management — schema prerequisites
-- =============================================================================
-- The vendor dashboard uses 'delivered' as the terminal "customer got it"
-- status; this adds it to orders_status_chk. 'completed' remains accepted
-- for legacy rows — no backfill/migration of existing data is required.
--
-- Idempotent — safe to re-run.
-- =============================================================================

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_chk;

ALTER TABLE orders ADD CONSTRAINT orders_status_chk
  CHECK (status IN (
    'pending', 'confirmed', 'preparing', 'ready',
    'delivered',   -- new: vendor handed order to customer
    'completed',   -- legacy, kept for existing rows
    'cancelled'
  ));
