-- Soft deletion: business data is never hard-deleted. A "deleted" row keeps
-- its data, gets deleted_at (+ who / why) and is filtered out of every list.
-- Safe to re-run. Run BEFORE deploying the code that uses these columns.

-- ── 1. Events: rejected, not deleted ────────────────────────────────────────
ALTER TABLE events ADD COLUMN IF NOT EXISTS rejected_at      timestamptz;
ALTER TABLE events ADD COLUMN IF NOT EXISTS rejected_by      uuid;
ALTER TABLE events ADD COLUMN IF NOT EXISTS rejection_reason text;

-- event_status gains 'rejected' (drop the old CHECK, whatever its name).
DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'public.events'::regclass AND contype = 'c'
              AND pg_get_constraintdef(oid) LIKE '%event_status%'
  LOOP
    EXECUTE format('ALTER TABLE events DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
ALTER TABLE events ADD CONSTRAINT events_event_status_chk
  CHECK (event_status IN ('upcoming', 'ongoing', 'completed', 'cancelled', 'rejected'));

-- ── 2. Menu items ────────────────────────────────────────────────────────────
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS deleted_by uuid;
CREATE INDEX IF NOT EXISTS menu_items_live_idx ON menu_items (restaurant_id) WHERE deleted_at IS NULL;

-- Public menu: deleted dishes never readable from the browser.
DROP POLICY IF EXISTS "public_read" ON menu_items;
CREATE POLICY "public_read" ON menu_items
  FOR SELECT TO anon, authenticated
  USING (
    menu_items.deleted_at IS NULL
    AND EXISTS (
      SELECT 1 FROM restaurants r
       WHERE r.id = menu_items.restaurant_id
         AND r.is_active = TRUE
         AND r.status IN ('active', 'approved')
         AND r.deleted_at IS NULL
    )
  );

-- ── 3. Platform team: removed, not deleted ───────────────────────────────────
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS deleted_by uuid;

-- status gains 'removed' (cannot log in, kept in the list as "Retiré").
DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'public.admin_users'::regclass AND contype = 'c'
              AND pg_get_constraintdef(oid) LIKE '%status%'
              AND pg_get_constraintdef(oid) LIKE '%suspended%'
  LOOP
    EXECUTE format('ALTER TABLE admin_users DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
ALTER TABLE admin_users ADD CONSTRAINT admin_users_status_chk
  CHECK (status IN ('active', 'suspended', 'removed'));

-- ── 4. Vouchers ──────────────────────────────────────────────────────────────
-- The row stays, so its code stays taken (the unique code index): a deleted
-- code can never be reused.
ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS deleted_by uuid;
CREATE INDEX IF NOT EXISTS vouchers_live_idx ON vouchers (created_at) WHERE deleted_at IS NULL;

DROP POLICY IF EXISTS "public_active_read" ON vouchers;
CREATE POLICY "public_active_read" ON vouchers
  FOR SELECT TO anon, authenticated
  USING (is_active = TRUE AND deleted_at IS NULL);

-- Checks:
-- SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conname IN ('events_event_status_chk', 'admin_users_status_chk');
-- SELECT table_name, column_name FROM information_schema.columns
--  WHERE table_schema = 'public' AND column_name IN ('deleted_at', 'deleted_by', 'rejected_at', 'rejected_by', 'rejection_reason')
--    AND table_name IN ('events', 'menu_items', 'admin_users', 'vouchers') ORDER BY 1, 2;
