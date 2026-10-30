-- Reference data (Admin → Données de référence) + proposals ("Autre…").
-- Safe to re-run: tables IF NOT EXISTS, seed ON CONFLICT DO NOTHING (an
-- admin's later edits are never overwritten by a re-run).

-- ── 1. The lists ─────────────────────────────────────────────────────────────
-- kind  city            code = the city name stored on rows (restaurants.city, events.city, places.city, customers.city)
--       cuisine         code = category id; restaurants keep their free-text cuisine_type, matched by keywords
--       event_category  code = events.category
--       place_category  code = places.category
CREATE TABLE IF NOT EXISTS ref_values (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        text NOT NULL CHECK (kind IN ('city', 'cuisine', 'event_category', 'place_category')),
  code        text NOT NULL,
  label_fr    text NOT NULL,
  label_en    text NOT NULL,
  icon        text,
  keywords    text[] NOT NULL DEFAULT '{}',
  country     text,                 -- cities: ISO-2 (CM, CI, SN, TG)
  lat         double precision,     -- cities: centre (map start, a new restaurant's pin)
  lng         double precision,
  zoom        smallint,
  visible     boolean NOT NULL DEFAULT true,   -- hidden = not offered anywhere; existing rows keep it
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, code)
);
CREATE INDEX IF NOT EXISTS ref_values_kind_order_idx ON ref_values (kind, sort_order);
ALTER TABLE ref_values ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ref_values_public_read ON ref_values;
CREATE POLICY ref_values_public_read ON ref_values FOR SELECT USING (visible);
-- No insert / update / delete policy: writes only through the admin API
-- (service role). Values are never deleted, only hidden.

-- ── 2. Proposals ("Autre… / Other…") ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ref_proposals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          text NOT NULL CHECK (kind IN ('city', 'cuisine', 'event_category', 'place_category')),
  proposed      text NOT NULL,                 -- what the user typed
  proposed_by   uuid REFERENCES customers(id) ON DELETE SET NULL,
  target_type   text NOT NULL CHECK (target_type IN ('restaurant', 'event', 'place', 'customer')),
  target_id     uuid NOT NULL,                 -- the restaurant / event / place / profile it came from
  saved_as      text,                          -- the value the item was saved with meanwhile
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'mapped', 'rejected')),
  resolved_code text,                          -- accepted / mapped: the value now set on the item
  resolved_by   uuid,
  resolved_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ref_proposals_status_idx ON ref_proposals (status, created_at);
ALTER TABLE ref_proposals ENABLE ROW LEVEL SECURITY;   -- no policy: admin API only

-- ── 3. Seed: today's values ──────────────────────────────────────────────────
INSERT INTO ref_values (kind, code, label_fr, label_en, country, lat, lng, zoom, visible, sort_order) VALUES
  ('city', 'Yaoundé', 'Yaoundé', 'Yaoundé', 'CM', 3.848,   11.5021,  13, true, 10),
  ('city', 'Douala',  'Douala',  'Douala',  'CM', 4.0511,  9.7679,   13, true, 20),
  ('city', 'Abidjan', 'Abidjan', 'Abidjan', 'CI', 5.36,    -4.0083,  13, false, 30),
  ('city', 'Dakar',   'Dakar',   'Dakar',   'SN', 14.6937, -17.4441, 13, false, 40),
  ('city', 'Lomé',    'Lomé',    'Lomé',    'TG', 6.1375,  1.2123,   13, false, 50)
ON CONFLICT (kind, code) DO NOTHING;

INSERT INTO ref_values (kind, code, label_fr, label_en, icon, keywords, sort_order) VALUES
  ('cuisine', 'grillades',    'Grillades',    'Grilled',     '🍖', ARRAY['grillade','grill','braise','brochette','bbq','barbecue','poulet dg','soya','rotisserie'], 10),
  ('cuisine', 'camerounaise', 'Camerounaise', 'Cameroonian', '🍛', ARRAY['camerounaise','cameroun','africain','african','traditionnel','ndole','eru','terroir'], 20),
  ('cuisine', 'senegalaise',  'Sénégalaise',  'Senegalese',  '🍽️', ARRAY['senegalaise','senegal','thieb','thieboudienne','yassa','mafe','dibi'], 25),
  ('cuisine', 'ivoirienne',   'Ivoirienne',   'Ivorian',     '🍽️', ARRAY['ivoirienne','ivoirien','attieke','garba','alloco','kedjenou','placali'], 26),
  ('cuisine', 'fastfood',     'Fast-food',    'Fast food',   '🍝', ARRAY['fast food','fastfood','fast-food','burger','sandwich','snack','shawarma','tacos','frites'], 30),
  ('cuisine', 'healthy',      'Healthy',      'Healthy',     '🥗', ARRAY['healthy','vegetarien','vegetarian','vegan','salade','salad','bio','jus','smoothie','poke'], 40),
  ('cuisine', 'pizza',        'Pizza',        'Pizza',       '🍕', ARRAY['pizza','pizzeria','italien','italian','pasta','pates'], 50),
  ('cuisine', 'poisson',      'Poisson',      'Fish',        '🐟', ARRAY['poisson','fish','fruits de mer','seafood','maquereau','bar braise','crevette','gambas'], 60),
  ('cuisine', 'bar',          'Bar',          'Drinks',      '🍺', ARRAY['bar','drink','boisson','lounge','club','cocktail','biere','beer','pub','cave'], 70),
  ('cuisine', 'desserts',     'Desserts',     'Desserts',    '🍰', ARRAY['dessert','patisserie','pastry','glace','ice cream','gateau','cake','boulangerie','bakery','crepe'], 80),
  ('cuisine', 'autre',        'Autre',        'Other',       '🍽️', ARRAY[]::text[], 999)
ON CONFLICT (kind, code) DO NOTHING;

INSERT INTO ref_values (kind, code, label_fr, label_en, icon, sort_order) VALUES
  ('event_category', 'Concert',     'Concert',     'Concert',      '🎵', 10),
  ('event_category', 'Festival',    'Festival',    'Festival',     '🎪', 20),
  ('event_category', 'BT/Club',     'BT/Club',     'BT/Club',      '🪩', 30),
  ('event_category', 'Sport',       'Sport',       'Sports',       '⚽', 40),
  ('event_category', 'Culture',     'Culture',     'Culture',      '🎭', 50),
  ('event_category', 'Gastronomie', 'Gastronomie', 'Food & Drink', '🍲', 60),
  ('event_category', 'Enfants',     'Enfants',     'Kids',         '👶', 70),
  ('event_category', 'Business',    'Business',    'Business',     '💼', 80),
  ('event_category', 'Autre',       'Autre',       'Other',        '🎉', 999)
ON CONFLICT (kind, code) DO NOTHING;

INSERT INTO ref_values (kind, code, label_fr, label_en, icon, sort_order) VALUES
  ('place_category', 'monuments', 'Monuments',              'Monuments',           '🏛️', 10),
  ('place_category', 'museums',   'Musées',                 'Museums',             '🖼️', 20),
  ('place_category', 'nature',    'Nature & points de vue', 'Nature & viewpoints', '🌳', 30),
  ('place_category', 'markets',   'Marchés',                'Markets',             '🧺', 40),
  ('place_category', 'culture',   'Culture & arts',         'Culture & arts',      '🎭', 50),
  ('place_category', 'worship',   'Lieux de culte',         'Places of worship',   '⛪', 60),
  ('place_category', 'crafts',    'Artisanat & shopping',   'Crafts & shopping',   '🛍️', 70),
  ('place_category', 'leisure',   'Loisirs & sport',        'Leisure & sport',     '⚽', 80),
  ('place_category', 'daytrips',  'Excursions',             'Day trips',           '🏖️', 90),
  ('place_category', 'autre',     'Autre',                  'Other',               '📍', 999)
ON CONFLICT (kind, code) DO NOTHING;

-- As run on 2026-10-30 (launch: Yaoundé + Douala visible). Checks: cities 2
-- visible / 5, cuisines 11, event categories 9, place categories 10.
-- SELECT kind, count(*) FROM ref_values GROUP BY kind ORDER BY kind;
