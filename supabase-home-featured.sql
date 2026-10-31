CREATE TABLE IF NOT EXISTS home_featured (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), city text NOT NULL, item_type text NOT NULL CHECK (item_type IN ('event', 'restaurant', 'place')), item_id uuid NOT NULL, starts_on date NOT NULL, ends_on date NOT NULL, created_by uuid, created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz, deleted_by uuid, CHECK (ends_on >= starts_on));
CREATE INDEX IF NOT EXISTS home_featured_city_dates ON home_featured (city, starts_on, ends_on) WHERE deleted_at IS NULL;
ALTER TABLE home_featured ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON home_featured FROM anon, authenticated;
GRANT SELECT (id, city, item_type, item_id, starts_on, ends_on, created_at) ON home_featured TO anon, authenticated;
DROP POLICY IF EXISTS public_read ON home_featured;
CREATE POLICY public_read ON home_featured FOR SELECT TO anon, authenticated USING (deleted_at IS NULL);
NOTIFY pgrst, 'reload schema';
