-- Prompt I — real content: restaurant links + admin notes (I2), places /
-- Lieux (I4), events for information only (I6). Run once in the Supabase
-- SQL Editor; safe to re-run. New tables are server-only (RLS on, no policy).

-- I2 — restaurant links (public) and an admin-only phone to verify.
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS instagram_url text;
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS facebook_url  text;
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS tiktok_url    text;
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS website_url   text;
CREATE TABLE IF NOT EXISTS restaurant_admin_notes (
  restaurant_id   uuid PRIMARY KEY REFERENCES restaurants(id) ON DELETE CASCADE,
  phone_to_verify text,
  note            text,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE restaurant_admin_notes ENABLE ROW LEVEL SECURITY;

-- I4 — places (Lieux). Server-only: RLS on, no policy.
CREATE TABLE IF NOT EXISTS places (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  city           text NOT NULL,
  area           text,
  category       text NOT NULL,
  title_fr       text NOT NULL,
  title_en       text,
  description_fr text,
  description_en text,
  tip_fr         text,
  tip_en         text,
  hours          text,
  price          text,
  official_link  text,
  instagram_url  text,
  facebook_url   text,
  tiktok_url     text,
  lat            double precision,
  lng            double precision,
  cover_url      text,
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'hidden')),
  managed_by_platform boolean NOT NULL DEFAULT true,
  submitted_by   uuid NULL REFERENCES customers(id) ON DELETE SET NULL,
  admin_note     text,
  sources        text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS places_city_status_idx ON places (city, status);
CREATE UNIQUE INDEX IF NOT EXISTS places_city_title_uniq ON places (city, lower(title_fr));
ALTER TABLE places ENABLE ROW LEVEL SECURITY;
ALTER TABLE events ADD COLUMN IF NOT EXISTS place_id uuid REFERENCES places(id) ON DELETE SET NULL;

-- I6 — events shown for information only (third-party events): no booking,
-- no payment, no QR; a "Billets / Infos" link instead.
ALTER TABLE events ADD COLUMN IF NOT EXISTS booking_mode text NOT NULL DEFAULT 'platform'
  CHECK (booking_mode IN ('platform', 'info'));
ALTER TABLE events ADD COLUMN IF NOT EXISTS info_link     text;
ALTER TABLE events ADD COLUMN IF NOT EXISTS price_is_from boolean NOT NULL DEFAULT false;

-- Checks: 2 table names, then 4 link columns, then 3 event columns
-- SELECT to_regclass('public.restaurant_admin_notes'), to_regclass('public.places');
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'restaurants' AND column_name IN ('instagram_url','facebook_url','tiktok_url','website_url');
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'events' AND column_name IN ('booking_mode','info_link','price_is_from');
