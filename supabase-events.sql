-- Events table migration
-- Run in Supabase SQL Editor: https://supabase.com/dashboard/project/xylfxtdgpptvieobvlfj/sql

CREATE TABLE IF NOT EXISTS events (
  id             UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  title          TEXT        NOT NULL,
  description    TEXT,
  date           DATE        NOT NULL,
  time           TEXT,
  venue          TEXT,
  city           TEXT        NOT NULL,
  neighborhood   TEXT,
  category       TEXT        NOT NULL,
  price          NUMERIC(10,2),
  cover_photo    TEXT,
  whatsapp       TEXT,
  organizer_name TEXT,
  is_active      BOOLEAN     DEFAULT false,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE events ENABLE ROW LEVEL SECURITY;

-- Public read (active only)
CREATE POLICY "Public can read active events"
  ON events FOR SELECT
  USING (is_active = true);

-- Public insert (submissions)
CREATE POLICY "Public can insert events"
  ON events FOR INSERT
  WITH CHECK (true);

-- Admin update / delete (open for demo)
CREATE POLICY "Public can update events"
  ON events FOR UPDATE
  USING (true);

CREATE POLICY "Public can delete events"
  ON events FOR DELETE
  USING (true);
