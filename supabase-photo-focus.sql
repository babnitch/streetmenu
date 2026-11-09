ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS image_focus text CHECK (image_focus ~ '^(100|[1-9]?[0-9]) (100|[1-9]?[0-9])$');
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS logo_focus text CHECK (logo_focus ~ '^(100|[1-9]?[0-9]) (100|[1-9]?[0-9])$');
ALTER TABLE events ADD COLUMN IF NOT EXISTS cover_focus text CHECK (cover_focus ~ '^(100|[1-9]?[0-9]) (100|[1-9]?[0-9])$');
GRANT SELECT (image_focus, logo_focus) ON restaurants TO anon, authenticated;
GRANT SELECT (cover_focus) ON events TO anon, authenticated;
NOTIFY pgrst, 'reload schema';
