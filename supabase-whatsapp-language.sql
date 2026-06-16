-- Per-customer WhatsApp language preference.
-- Customers see notifications in their preferred language only (FR or EN),
-- toggleable from chat with "en" / "fr". Defaults to FR — the majority
-- of users are in Cameroon/Senegal/Côte d'Ivoire / Togo.
--
-- Run in Supabase SQL Editor:
-- https://supabase.com/dashboard/project/xylfxtdgpptvieobvlfj/sql

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS preferred_language TEXT DEFAULT 'fr';

-- Defensive backfill — every existing customer gets FR if NULL slipped in.
UPDATE customers
  SET preferred_language = 'fr'
  WHERE preferred_language IS NULL;

-- Constrain to the two values the app currently supports. The CHECK is
-- added separately so the migration is safe to re-run.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.check_constraints
    WHERE constraint_name = 'customers_preferred_language_check'
  ) THEN
    ALTER TABLE customers
      ADD CONSTRAINT customers_preferred_language_check
      CHECK (preferred_language IN ('fr', 'en'));
  END IF;
END $$;
