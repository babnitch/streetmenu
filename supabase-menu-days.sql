-- Menu par jour (D1–D3). Safe to re-run. Run in the Supabase SQL Editor,
-- then reply "SQL done".
--
-- restaurants.menu_type: 'a_la_carte' (default — the same menu every day,
-- nothing changes) or 'daily' ("Menu par jour").
-- menu_items.available_days: the days a dish is served, 0 = Sunday … 6 =
-- Saturday (same numbering as restaurant_hours.day_of_week). Default: every
-- day. Only read when the restaurant is in "Menu par jour".
-- Every existing restaurant stays À la carte; every existing dish gets all
-- seven days.

ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS menu_type text NOT NULL DEFAULT 'a_la_carte';
DO $$ BEGIN
  ALTER TABLE restaurants ADD CONSTRAINT restaurants_menu_type_ok CHECK (menu_type IN ('a_la_carte', 'daily'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS available_days smallint[] NOT NULL DEFAULT '{0,1,2,3,4,5,6}';
DO $$ BEGIN
  ALTER TABLE menu_items ADD CONSTRAINT menu_items_available_days_ok CHECK (
    available_days <@ ARRAY[0,1,2,3,4,5,6]::smallint[] AND cardinality(available_days) >= 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

NOTIFY pgrst, 'reload schema';

-- ── Check ──────────────────────────────────────────────────────────────────
-- SELECT menu_type, count(*) FROM restaurants GROUP BY menu_type;                 -- only a_la_carte
-- SELECT count(*) FROM menu_items WHERE cardinality(available_days) <> 7;         -- 0
