ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS photo_credit text;
ALTER TABLE events ADD COLUMN IF NOT EXISTS photo_credit text;
GRANT SELECT (photo_credit) ON restaurants TO anon, authenticated;
GRANT SELECT (photo_credit) ON events TO anon, authenticated;
NOTIFY pgrst, 'reload schema';
