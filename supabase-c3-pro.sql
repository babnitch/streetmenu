-- Client/Pro C3. Safe to re-run.
--
-- 1. events.notify_phone — an extra number that also receives this event's
--    notifications (new booking, approved/rejected, cancellations), besides
--    the organiser's account phone. Pre-filled from the Pro profile's
--    customers.pro_notify_phone; NULL = account phone only. +E.164.
--
-- 2. customers.default_mode — the mode the account opens in after a login:
--    'client' (everyone today) or 'pro' (set by the Pro sign-up path, and by
--    the mode switch in Mon compte). Stored on the account so it follows the
--    person to every device.

ALTER TABLE events    ADD COLUMN IF NOT EXISTS notify_phone text;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS default_mode text NOT NULL DEFAULT 'client';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'events_notify_phone_format') THEN
    ALTER TABLE events ADD CONSTRAINT events_notify_phone_format
      CHECK (notify_phone IS NULL OR notify_phone ~ '^\+[0-9]{6,15}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customers_default_mode_check') THEN
    ALTER TABLE customers ADD CONSTRAINT customers_default_mode_check
      CHECK (default_mode IN ('client', 'pro'));
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';

-- Checks (expect 2 rows, then 0):
-- SELECT table_name, column_name FROM information_schema.columns
--   WHERE (table_name, column_name) IN (('events','notify_phone'), ('customers','default_mode'));
-- SELECT count(*) FROM customers WHERE default_mode <> 'client';


-- ── OPTIONAL data fix (run separately if you want it) ───────────────────────
-- Restaurants signed up on WhatsApp sit at map position 0,0 (in the sea off
-- West Africa). From C3 new ones get their city centre; this moves the
-- existing ones there too. Today: 1 active restaurant in Yaoundé (plus 2
-- deleted ones, left alone). Owners can refine the pin later.
--
-- UPDATE restaurants r SET lat = c.lat, lng = c.lng, updated_at = now()
-- FROM (VALUES ('Yaoundé', 3.8480, 11.5021), ('Abidjan', 5.3600, -4.0083),
--              ('Dakar', 14.6937, -17.4441), ('Lomé', 6.1375, 1.2123)) AS c(city, lat, lng)
-- WHERE r.city = c.city AND r.deleted_at IS NULL
--   AND COALESCE(r.lat, 0) = 0 AND COALESCE(r.lng, 0) = 0
-- RETURNING r.id, r.name, r.city;
