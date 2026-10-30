-- Anonymous daily counts (Aperçu, Admin → Statistiques). One row per
-- (day, city, item type, item id, metric) with a count — no cookie, no IP,
-- no user id, ever. Searches keep the words (item_id), not who searched.
-- Safe to re-run.
CREATE TABLE IF NOT EXISTS stats_daily (
  day        date    NOT NULL,
  city       text    NOT NULL DEFAULT '',
  item_type  text    NOT NULL DEFAULT '',   -- '' (site) | restaurant | event | place | search
  item_id    text    NOT NULL DEFAULT '',   -- uuid, or the search words
  metric     text    NOT NULL,              -- visit | view | click_whatsapp | click_call | click_tickets | click_directions | click_map | search
  count      integer NOT NULL DEFAULT 0,
  PRIMARY KEY (day, city, item_type, item_id, metric)
);
CREATE INDEX IF NOT EXISTS stats_daily_item_idx ON stats_daily (item_type, item_id, day);
ALTER TABLE stats_daily ENABLE ROW LEVEL SECURITY;

-- +n on a counter, atomically.
CREATE OR REPLACE FUNCTION stats_bump(p_day date, p_city text, p_type text, p_id text, p_metric text, p_n integer DEFAULT 1)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO stats_daily (day, city, item_type, item_id, metric, count)
  VALUES (p_day, COALESCE(p_city, ''), COALESCE(p_type, ''), COALESCE(p_id, ''), p_metric, p_n)
  ON CONFLICT (day, city, item_type, item_id, metric) DO UPDATE SET count = stats_daily.count + EXCLUDED.count;
$$;
REVOKE ALL ON FUNCTION stats_bump(date, text, text, text, text, integer) FROM PUBLIC, anon, authenticated;
