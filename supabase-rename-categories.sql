-- =============================================================================
-- Rename event categories to the new canonical set
-- Run this in Supabase SQL Editor
-- =============================================================================
-- One-shot rename of the legacy category names that lived since the events
-- table was created. Final canonical list (9 entries):
--
--   Concert · Festival · BT/Club · Sport · Culture · Gastronomie · Enfants
--   Business · Autre
--
-- Mapping applied:
--   Music     → Concert
--   Food      → Gastronomie
--   Art       → Culture
--   Nightlife → Festival
--   BT / Club → BT/Club   (drop the spaces around the slash)
--   BT        → BT/Club   (collapse — was never a separate canonical entry
--                          but defensive in case any row slipped through)
--   Club      → BT/Club   (same)
--
-- Sport / Enfants / Business / Autre are unchanged.
--
-- Idempotent — safe to re-run; each UPDATE has no rows to touch once the
-- rename has already happened.
--
-- The events.category column has no CHECK constraint, so no constraint
-- needs to be dropped/recreated. The rename also reaches into the two
-- columns that store category filters as TEXT[] arrays:
--
--   event_subscriptions.categories
--   broadcasts.target_categories
--
-- Array entries are remapped via unnest + a CASE expression, and the
-- result is de-duplicated through array_agg(DISTINCT …) so a row that
-- previously held both 'BT' and 'Club' ends up with a single 'BT/Club'.
-- =============================================================================

BEGIN;

-- 1. events.category --------------------------------------------------------
UPDATE events SET category = 'Concert'     WHERE category = 'Music';
UPDATE events SET category = 'Gastronomie' WHERE category = 'Food';
UPDATE events SET category = 'Culture'     WHERE category = 'Art';
UPDATE events SET category = 'Festival'    WHERE category = 'Nightlife';
UPDATE events SET category = 'BT/Club'     WHERE category IN ('BT / Club', 'BT', 'Club');

-- 2. event_subscriptions.categories[] --------------------------------------
-- Only touches rows that actually contain a legacy name, so it's cheap to
-- re-run. The CASE remaps every entry; DISTINCT drops the duplicates that
-- the BT/Club merge can create.
UPDATE event_subscriptions
   SET categories = sub.new_cats
  FROM (
    SELECT s.id,
           (
             SELECT array_agg(DISTINCT m.mapped ORDER BY m.mapped)
               FROM unnest(s.categories) AS old
                    CROSS JOIN LATERAL (
                      SELECT CASE old
                        WHEN 'Music'     THEN 'Concert'
                        WHEN 'Food'      THEN 'Gastronomie'
                        WHEN 'Art'       THEN 'Culture'
                        WHEN 'Nightlife' THEN 'Festival'
                        WHEN 'BT / Club' THEN 'BT/Club'
                        WHEN 'BT'        THEN 'BT/Club'
                        WHEN 'Club'      THEN 'BT/Club'
                        ELSE old
                      END AS mapped
                    ) m
           ) AS new_cats
      FROM event_subscriptions s
     WHERE s.categories IS NOT NULL
       AND s.categories && ARRAY['Music','Food','Art','Nightlife','BT / Club','BT','Club']
  ) sub
 WHERE event_subscriptions.id = sub.id;

-- 3. broadcasts.target_categories[] ----------------------------------------
UPDATE broadcasts
   SET target_categories = sub.new_cats
  FROM (
    SELECT b.id,
           (
             SELECT array_agg(DISTINCT m.mapped ORDER BY m.mapped)
               FROM unnest(b.target_categories) AS old
                    CROSS JOIN LATERAL (
                      SELECT CASE old
                        WHEN 'Music'     THEN 'Concert'
                        WHEN 'Food'      THEN 'Gastronomie'
                        WHEN 'Art'       THEN 'Culture'
                        WHEN 'Nightlife' THEN 'Festival'
                        WHEN 'BT / Club' THEN 'BT/Club'
                        WHEN 'BT'        THEN 'BT/Club'
                        WHEN 'Club'      THEN 'BT/Club'
                        ELSE old
                      END AS mapped
                    ) m
           ) AS new_cats
      FROM broadcasts b
     WHERE b.target_categories IS NOT NULL
       AND b.target_categories && ARRAY['Music','Food','Art','Nightlife','BT / Club','BT','Club']
  ) sub
 WHERE broadcasts.id = sub.id;

COMMIT;
