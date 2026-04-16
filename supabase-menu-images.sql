-- Run in Supabase SQL Editor to create the menu-images storage bucket
-- Dashboard: https://supabase.com/dashboard/project/xylfxtdgpptvieobvlfj/sql

-- 1. Create bucket (public)
INSERT INTO storage.buckets (id, name, public)
VALUES ('menu-images', 'menu-images', true)
ON CONFLICT (id) DO NOTHING;

-- 2. Allow public reads
CREATE POLICY "menu_images_public_read"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'menu-images');

-- 3. Allow service role to insert (used by the WhatsApp webhook)
CREATE POLICY "menu_images_service_insert"
  ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'menu-images');
