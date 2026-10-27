-- Pro profile (Client/Pro C2).
--
-- Two optional fields on the account, filled once in the Pro profile and
-- pre-filled into "Créer un événement":
--   pro_name          organiser / association name. The event form copies it
--                     into events.organizer_name, which stays editable per
--                     event.
--   pro_notify_phone  an extra number that also receives the organiser's
--                     event notifications (C3 wires the sending). Stored
--                     +E.164, like customers.phone.
--
-- Both NULL by default: nothing changes for existing accounts.
-- Safe to re-run.

ALTER TABLE customers ADD COLUMN IF NOT EXISTS pro_name text;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS pro_notify_phone text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customers_pro_name_len') THEN
    ALTER TABLE customers ADD CONSTRAINT customers_pro_name_len
      CHECK (pro_name IS NULL OR char_length(pro_name) BETWEEN 1 AND 80);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customers_pro_notify_phone_format') THEN
    ALTER TABLE customers ADD CONSTRAINT customers_pro_notify_phone_format
      CHECK (pro_notify_phone IS NULL OR pro_notify_phone ~ '^\+[0-9]{6,15}$');
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';

-- Check (expect 2 rows):
-- SELECT column_name, data_type FROM information_schema.columns
-- WHERE table_name = 'customers' AND column_name IN ('pro_name', 'pro_notify_phone');
