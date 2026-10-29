-- N4a — Menu as photos or PDF, and WhatsApp contact clicks.
-- Run once in the Supabase SQL Editor. Safe to re-run.

-- 1. Menu files: up to 5 per restaurant, at most one PDF (checked by the
--    server). Read and written by the server only: RLS on, no policy.
CREATE TABLE IF NOT EXISTS restaurant_menu_files (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  path          text NOT NULL,
  url           text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('photo', 'pdf')),
  position      smallint NOT NULL DEFAULT 0,
  bytes         integer NOT NULL DEFAULT 0 CHECK (bytes >= 0 AND bytes <= 5242880),
  added_by      uuid NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS restaurant_menu_files_restaurant_idx ON restaurant_menu_files (restaurant_id, position);
ALTER TABLE restaurant_menu_files ENABLE ROW LEVEL SECURITY;

-- 2. Storage bucket: public read, 5 MB per file, photos and PDF only.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('menu-files', 'menu-files', true, 5242880,
        ARRAY['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
ON CONFLICT (id) DO UPDATE
  SET public = true,
      file_size_limit = 5242880,
      allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];

-- 3. "Commander sur WhatsApp" / "Appeler" clicks on a restaurant page, so we
--    can show a restaurant how many customers we send. Server only.
CREATE TABLE IF NOT EXISTS restaurant_contact_clicks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('whatsapp', 'call')),
  customer_id   uuid NULL REFERENCES customers(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS restaurant_contact_clicks_restaurant_idx ON restaurant_contact_clicks (restaurant_id, created_at DESC);
ALTER TABLE restaurant_contact_clicks ENABLE ROW LEVEL SECURITY;

-- Checks (should return: 2 rows, then 1 row with 5242880)
-- SELECT to_regclass('public.restaurant_menu_files'), to_regclass('public.restaurant_contact_clicks');
-- SELECT id, public, file_size_limit FROM storage.buckets WHERE id = 'menu-files';
