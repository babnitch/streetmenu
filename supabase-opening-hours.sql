-- =============================================================================
-- Restaurant opening hours + manual override
-- Run this in Supabase SQL Editor
-- =============================================================================
-- Weekly schedule per restaurant + a manual override the owner can flip
-- from the dashboard. `is_open` on restaurants becomes derived rather than
-- canonical, but we keep the column populated for back-compat (cached for
-- the home-card bulk endpoint to overwrite when it computes status).
-- Idempotent — safe to re-run.
-- =============================================================================

-- 1. restaurant_hours ---------------------------------------------------------
-- One row per (restaurant, day_of_week). Sunday=0 through Saturday=6 — that
-- matches JS Date.getDay() so the lib/openingHours.ts comparisons stay
-- one-to-one with native dates.
CREATE TABLE IF NOT EXISTS restaurant_hours (
  id            UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID    NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  day_of_week   INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  open_time     TIME    NOT NULL DEFAULT '08:00',
  close_time    TIME    NOT NULL DEFAULT '22:00',
  is_closed     BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE (restaurant_id, day_of_week)
);
ALTER TABLE restaurant_hours ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'restaurant_hours' AND policyname = 'restaurant_hours_select'
  ) THEN
    -- Hours are public — they show on the restaurant page for everyone.
    CREATE POLICY "restaurant_hours_select" ON restaurant_hours FOR SELECT USING (true);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS restaurant_hours_restaurant_idx ON restaurant_hours(restaurant_id);

-- 2. restaurants: manual override + timezone + closed-order toggle ------------
-- timezone defaults to Africa/Douala (UTC+1) for Cameroon; the seed below
-- adjusts cities outside Cameroon to their actual IANA zone.
-- allow_orders_when_closed defaults TRUE so the new column doesn't silently
-- block ordering on existing rows during the migration window — the
-- closed-order warning UI in Batch J reads this flag to decide whether to
-- disable the "Order" button outright vs. just warn.
ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS manual_override          TEXT
    CHECK (manual_override IS NULL OR manual_override IN ('open', 'closed')),
  ADD COLUMN IF NOT EXISTS manual_override_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS timezone                 TEXT NOT NULL DEFAULT 'Africa/Douala',
  ADD COLUMN IF NOT EXISTS allow_orders_when_closed BOOLEAN NOT NULL DEFAULT TRUE;

-- 3. Backfill timezone per city ------------------------------------------------
-- Only rewrite the default. Custom timezones already set by an admin
-- stay intact.
UPDATE restaurants SET timezone = 'Africa/Abidjan' WHERE city = 'Abidjan'  AND timezone = 'Africa/Douala';
UPDATE restaurants SET timezone = 'Africa/Dakar'   WHERE city = 'Dakar'    AND timezone = 'Africa/Douala';
UPDATE restaurants SET timezone = 'Africa/Lome'    WHERE city = 'Lomé'     AND timezone = 'Africa/Douala';
UPDATE restaurants SET timezone = 'Africa/Lome'    WHERE city = 'Lome'     AND timezone = 'Africa/Douala';

-- 4. Seed default hours for restaurants missing a schedule ---------------------
-- Mon-Sat 08:00-22:00, Sun closed. Runs once per (restaurant, day) thanks
-- to the UNIQUE constraint; re-running this script is a no-op.
INSERT INTO restaurant_hours (restaurant_id, day_of_week, open_time, close_time, is_closed)
SELECT r.id, d.day_of_week,
       CASE WHEN d.day_of_week = 0 THEN '00:00'::time ELSE '08:00'::time END,
       CASE WHEN d.day_of_week = 0 THEN '00:00'::time ELSE '22:00'::time END,
       (d.day_of_week = 0)
  FROM restaurants r
  CROSS JOIN (SELECT generate_series(0, 6) AS day_of_week) d
  WHERE NOT EXISTS (
    SELECT 1 FROM restaurant_hours rh WHERE rh.restaurant_id = r.id AND rh.day_of_week = d.day_of_week
  );
