-- ── Payment modes ────────────────────────────────────────────────────────────
-- Replaces the simple payment_enabled on/off flag with a 3-way payment_mode
-- plus a separate whatsapp_payment_enabled toggle, for both restaurants and
-- events.
--
--   payment_only      — customer MUST pay online (Mobile Money). No reservation.
--   reservation_only  — customer reserves, pays on-site / at the door. DEFAULT.
--   both              — customer chooses at checkout: pay now OR reserve.
--
-- whatsapp_payment_enabled (default FALSE) gates online payment inside the
-- WhatsApp flow independently of the web payment_mode. When FALSE, WhatsApp
-- ordering is always reservation_only regardless of payment_mode.
--
-- The legacy payment_enabled column is kept for backward compatibility (and is
-- written in sync with payment_mode by the API) but is no longer read for
-- behaviour — payment_mode is the source of truth.
--
-- Migration preserves current behaviour:
--   payment_enabled = true  → payment_mode = 'both'  (customer could choose)
--   payment_enabled = false → payment_mode = 'reservation_only'
-- whatsapp_payment_enabled defaults FALSE so existing WhatsApp flows stay
-- reservation-only until a vendor explicitly opts in.

-- ── restaurants ──────────────────────────────────────────────────────────────
ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS payment_mode text NOT NULL DEFAULT 'reservation_only'
    CHECK (payment_mode IN ('payment_only', 'reservation_only', 'both'));

ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS whatsapp_payment_enabled boolean NOT NULL DEFAULT false;

-- One-time backfill from the legacy flag. Guarded so re-running the migration
-- doesn't clobber modes an admin has since set by hand: only touch rows still
-- sitting at the column default while payment was previously enabled.
UPDATE restaurants
  SET payment_mode = CASE WHEN payment_enabled = true THEN 'both' ELSE 'reservation_only' END
  WHERE payment_mode = 'reservation_only';

-- ── events ───────────────────────────────────────────────────────────────────
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS payment_mode text NOT NULL DEFAULT 'reservation_only'
    CHECK (payment_mode IN ('payment_only', 'reservation_only', 'both'));

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS whatsapp_payment_enabled boolean NOT NULL DEFAULT false;

UPDATE events
  SET payment_mode = CASE WHEN payment_enabled = true THEN 'both' ELSE 'reservation_only' END
  WHERE payment_mode = 'reservation_only';
