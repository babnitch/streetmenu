-- Lieux photos (Wikimedia Commons): the credit shown on the photo.
-- photo_credit = "{author}, {licence}" exactly as Commons gives them;
-- photo_credit_url = the file page on Commons. Safe to re-run.
ALTER TABLE places ADD COLUMN IF NOT EXISTS photo_credit text;
ALTER TABLE places ADD COLUMN IF NOT EXISTS photo_credit_url text;
