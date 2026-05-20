-- =============================================================================
-- Image optimization — blur-hash placeholders
-- Run this in Supabase SQL Editor
-- =============================================================================
-- Adds a `blur_hash` column to every image-bearing table. The column
-- stores a tiny base64-encoded WebP (10×10 px, quality=30, ~300 bytes)
-- generated server-side at upload time by lib/imageOptimizer.ts. The
-- web client passes the value to Next.js <Image blurDataURL=…> so the
-- first paint shows an instant blurred preview while the full asset
-- streams in.
--
-- Nullable on purpose — historical rows that haven't been re-uploaded
-- since the migration won't have a placeholder and will fall back to
-- the generic gradient.
-- =============================================================================

ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS blur_hash TEXT;
ALTER TABLE menu_items  ADD COLUMN IF NOT EXISTS blur_hash TEXT;
ALTER TABLE events      ADD COLUMN IF NOT EXISTS blur_hash TEXT;
