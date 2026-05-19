-- =============================================================================
-- Sample "Enfants / Kids" events — Yaoundé seed data
-- Run this in Supabase SQL Editor
-- =============================================================================
-- Three upcoming family-friendly events used to populate the new "Enfants"
-- category. Each row is inserted only when no event with the same (title,
-- date, city) already exists, so re-running this file is safe.
--
-- Both `price` and `ticket_price` are set to the same value. The legacy
-- events.price column drives the "Gratuit / Free" pill on the event
-- card; events.ticket_price drives the reservation flow. Keeping them in
-- sync avoids a Free badge over a paid event.
-- =============================================================================

-- 1. Painting workshop — Sat 2026-06-06, 14:00 ------------------------------
INSERT INTO events (
  title, description, date, time, venue, city, neighborhood,
  category, price, ticket_price, max_tickets, is_active, event_status
)
SELECT
  'Atelier Peinture pour Enfants / Kids Painting Workshop',
  'Un après-midi créatif pour les enfants de 4 à 12 ans. Peinture, dessin et bricolage encadrés par des animateurs professionnels. / A creative afternoon for kids aged 4-12. Painting, drawing and crafts led by professional facilitators.',
  DATE '2026-06-06', '14:00',
  'Centre Culturel Camerounais, Bastos', 'Yaoundé', 'Bastos',
  'Enfants', 2000, 2000, 30, TRUE, 'upcoming'
WHERE NOT EXISTS (
  SELECT 1 FROM events
  WHERE title = 'Atelier Peinture pour Enfants / Kids Painting Workshop'
    AND date  = DATE '2026-06-06'
    AND city  = 'Yaoundé'
);

-- 2. Puppet show — Sun 2026-06-14, 15:00 -------------------------------------
INSERT INTO events (
  title, description, date, time, venue, city, neighborhood,
  category, price, ticket_price, max_tickets, is_active, event_status
)
SELECT
  'Spectacle de Marionnettes / Puppet Show',
  'Spectacle interactif de marionnettes avec contes africains traditionnels. Pour enfants de 3 à 10 ans. Goûter inclus! / Interactive puppet show with traditional African tales. For kids 3-10. Snacks included!',
  DATE '2026-06-14', '15:00',
  'Parc Municipal de Yaoundé', 'Yaoundé', 'Centre',
  'Enfants', 0, 0, 50, TRUE, 'upcoming'
WHERE NOT EXISTS (
  SELECT 1 FROM events
  WHERE title = 'Spectacle de Marionnettes / Puppet Show'
    AND date  = DATE '2026-06-14'
    AND city  = 'Yaoundé'
);

-- 3. Mini Chef cooking class — Sat 2026-06-20, 10:00 -------------------------
INSERT INTO events (
  title, description, date, time, venue, city, neighborhood,
  category, price, ticket_price, max_tickets, is_active, event_status
)
SELECT
  'Mini Chef — Cours de Cuisine pour Enfants / Kids Cooking Class',
  'Les petits chefs apprennent à préparer des plats camerounais simples. Tablier fourni, chaque enfant repart avec sa création! Pour 6-14 ans. / Little chefs learn to make simple Cameroonian dishes. Apron provided, each child takes home their creation! Ages 6-14.',
  DATE '2026-06-20', '10:00',
  'Chez Mama Biya, Omnisport', 'Yaoundé', 'Omnisport',
  'Enfants', 5000, 5000, 15, TRUE, 'upcoming'
WHERE NOT EXISTS (
  SELECT 1 FROM events
  WHERE title = 'Mini Chef — Cours de Cuisine pour Enfants / Kids Cooking Class'
    AND date  = DATE '2026-06-20'
    AND city  = 'Yaoundé'
);
