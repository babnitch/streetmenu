-- =============================================================================
-- Account System Migration
-- Run this in Supabase SQL Editor
-- =============================================================================

-- Enable pgcrypto extension for crypt() / gen_salt()
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =============================================================================
-- 1. ADMIN USERS TABLE
-- =============================================================================
CREATE TABLE IF NOT EXISTS admin_users (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email        text UNIQUE NOT NULL,
  password_hash text NOT NULL,
  name         text NOT NULL,
  role         text NOT NULL CHECK (role IN ('super_admin', 'admin', 'moderator')),
  created_by   uuid REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at   timestamptz DEFAULT now(),
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended'))
);

-- RLS: only service role accesses this table
ALTER TABLE admin_users ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_only" ON admin_users USING (false);

-- =============================================================================
-- 2. RESTAURANT TEAM TABLE
-- =============================================================================
CREATE TABLE IF NOT EXISTS restaurant_team (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  customer_id   uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  role          text NOT NULL CHECK (role IN ('owner', 'manager', 'staff')),
  added_by      uuid REFERENCES customers(id) ON DELETE SET NULL,
  added_at      timestamptz DEFAULT now(),
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
  UNIQUE (restaurant_id, customer_id)
);

ALTER TABLE restaurant_team ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_only" ON restaurant_team USING (false);

-- =============================================================================
-- 3. ADD COLUMNS TO customers TABLE
-- =============================================================================
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS status           text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'deleted')),
  ADD COLUMN IF NOT EXISTS suspended_at     timestamptz,
  ADD COLUMN IF NOT EXISTS suspended_by     text CHECK (suspended_by IN ('vendor', 'admin', 'system')),
  ADD COLUMN IF NOT EXISTS suspension_reason text,
  ADD COLUMN IF NOT EXISTS deleted_at       timestamptz;

-- =============================================================================
-- 4. ADD COLUMNS TO restaurants TABLE
-- =============================================================================
-- Link restaurant owner to customer record
ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS customer_id      uuid REFERENCES customers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS image_url        text,
  ADD COLUMN IF NOT EXISTS suspended_at     timestamptz,
  ADD COLUMN IF NOT EXISTS suspended_by     text CHECK (suspended_by IN ('vendor', 'admin', 'system')),
  ADD COLUMN IF NOT EXISTS suspension_reason text,
  ADD COLUMN IF NOT EXISTS deleted_at       timestamptz;

-- Extend status column to support new values
-- First drop the existing check constraint if any, then re-add with extended values
DO $$
BEGIN
  -- Add status column if it doesn't exist (some installs may already have it)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'restaurants' AND column_name = 'status'
  ) THEN
    ALTER TABLE restaurants ADD COLUMN status text NOT NULL DEFAULT 'pending';
  END IF;
END $$;

-- =============================================================================
-- 5. BACKFILL: link existing restaurants to customers via whatsapp number
-- =============================================================================
UPDATE restaurants r
SET customer_id = c.id
FROM customers c
WHERE r.whatsapp = c.phone
  AND r.customer_id IS NULL;

-- =============================================================================
-- 6. BACKFILL: create owner entries in restaurant_team for existing restaurants
-- =============================================================================
INSERT INTO restaurant_team (restaurant_id, customer_id, role, added_by)
SELECT r.id, r.customer_id, 'owner', r.customer_id
FROM restaurants r
WHERE r.customer_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM restaurant_team rt
    WHERE rt.restaurant_id = r.id AND rt.customer_id = r.customer_id AND rt.role = 'owner'
  );

-- =============================================================================
-- 7. FIRST SUPER ADMIN (change the password before running!)
-- =============================================================================
-- INSERT INTO admin_users (email, password_hash, name, role)
-- VALUES (
--   'admin@ndjoka-tchop.com',
--   crypt('CHANGE_THIS_PASSWORD', gen_salt('bf')),
--   'Super Admin',
--   'super_admin'
-- );
-- ⚠️  Uncomment the above block, set a real password, run it ONCE, then recomment.
