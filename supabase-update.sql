-- StreetMenu Schema Update
-- Run this in your Supabase SQL Editor

-- Add city column to restaurants
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS city TEXT;

-- Add is_active column (platform-level visibility, distinct from is_open)
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true NOT NULL;

-- Allow admin to update is_active (already covered by existing update policy)
-- But add a policy for is_active specifically if needed:
-- (The existing "Public can update restaurants" policy already covers this)

-- Update sample data with city values
UPDATE restaurants SET city = 'Zurich', is_active = true WHERE city IS NULL;

-- Backfill: make sure all existing restaurants are active
UPDATE restaurants SET is_active = true WHERE is_active IS NULL;
