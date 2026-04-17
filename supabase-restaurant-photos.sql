-- Restaurant photos & menu management migration
-- Run in Supabase SQL Editor:
-- https://supabase.com/dashboard/project/xylfxtdgpptvieobvlfj/sql

-- ── 1. Add image_url to restaurants ──────────────────────────────────────────
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS image_url TEXT;

-- ── 2. Allow 'photo_update' as a signup_sessions user_type ───────────────────
--    Drop the CHECK constraint so we can add the new type without recreating the table.
ALTER TABLE signup_sessions
  DROP CONSTRAINT IF EXISTS signup_sessions_user_type_check;

ALTER TABLE signup_sessions
  ADD CONSTRAINT signup_sessions_user_type_check
  CHECK (user_type IN ('customer', 'vendor', 'photo_update'));

-- ── 3. restaurant-images Storage bucket ──────────────────────────────────────
INSERT INTO storage.buckets (id, name, public)
VALUES ('restaurant-images', 'restaurant-images', true)
ON CONFLICT (id) DO NOTHING;

-- Public read for restaurant images
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'objects'
      AND policyname = 'restaurant_images_public_read'
  ) THEN
    CREATE POLICY "restaurant_images_public_read"
      ON storage.objects FOR SELECT
      USING (bucket_id = 'restaurant-images');
  END IF;
END $$;

-- Allow inserts from service role (API routes use service role key)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'objects'
      AND policyname = 'restaurant_images_insert'
  ) THEN
    CREATE POLICY "restaurant_images_insert"
      ON storage.objects FOR INSERT
      WITH CHECK (bucket_id = 'restaurant-images');
  END IF;
END $$;
