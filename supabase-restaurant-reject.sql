-- Rejecting a pending restaurant keeps it (soft deletion rule):
-- status 'rejected' + who / when / why. deleted_at is also set, so every
-- existing list (all filter deleted_at IS NULL) hides it at once; the admin
-- shows it under Restaurants → Rejetés. Safe to re-run.

ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS rejected_at      timestamptz;
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS rejected_by      uuid;
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS rejection_reason text;

-- status gains 'rejected' (drop the old CHECK, whatever its name).
DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'public.restaurants'::regclass AND contype = 'c'
              AND pg_get_constraintdef(oid) LIKE '%status%'
              AND pg_get_constraintdef(oid) LIKE '%suspended%'
  LOOP
    EXECUTE format('ALTER TABLE restaurants DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
ALTER TABLE restaurants ADD CONSTRAINT restaurants_status_chk
  CHECK (status IN ('pending', 'active', 'approved', 'suspended', 'deleted', 'rejected'));

-- Checks:
-- SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'restaurants_status_chk';
-- SELECT column_name FROM information_schema.columns
--  WHERE table_schema = 'public' AND table_name = 'restaurants'
--    AND column_name IN ('rejected_at', 'rejected_by', 'rejection_reason');   -- 3 rows
