-- Modules per pro + platform switches (M1–M7).
--
-- HOW TO RUN
--   1. Run PART 1 (PREVIEW) alone. It changes nothing: one row per restaurant
--      and per organiser with the modules the backfill WILL give them.
--      Send the result before going further.
--   2. Then run PART 2 (APPLY). Safe to re-run. Reply "SQL done".
--
-- Modules
--   restaurant (restaurants.modules):
--     orders · payment (needs orders) · delivery (needs orders) · team ·
--     promo_codes · daily_offer · broadcast · featured · stats
--   organiser (customers.organizer_modules — applies to all their events):
--     reservations · paid_tickets (needs reservations) · ticket_control ·
--     promo_codes · featured · broadcast · auto_approve
--   Basic (Vitrine / event page) is not a module: everyone has it.
--
-- Backfill = what each pro uses today (decision 1: every existing restaurant
-- keeps Commandes). New restaurants and organisers start with Basic only.


-- ════════════════════════════════════════════════════════════════════════════
-- PART 1 — PREVIEW (read-only). Run this alone first.
-- ════════════════════════════════════════════════════════════════════════════
WITH r AS (
  SELECT
    'restaurant'::text AS pro, rs.name, rs.city, rs.status,
    array_remove(ARRAY[
      'orders',
      CASE WHEN rs.payment_mode IN ('payment_only', 'both') OR rs.whatsapp_payment_enabled IS TRUE THEN 'payment' END,
      CASE WHEN rs.delivery_enabled IS TRUE THEN 'delivery' END,
      CASE WHEN EXISTS (SELECT 1 FROM restaurant_team t WHERE t.restaurant_id = rs.id AND t.role <> 'owner' AND t.status IN ('active', 'pending'))
             OR EXISTS (SELECT 1 FROM team_invitations i WHERE i.restaurant_id = rs.id) THEN 'team' END,
      CASE WHEN EXISTS (SELECT 1 FROM vouchers v WHERE v.restaurant_id = rs.id) THEN 'promo_codes' END,
      CASE WHEN EXISTS (SELECT 1 FROM menu_offers o WHERE o.restaurant_id = rs.id) THEN 'daily_offer' END,
      CASE WHEN rs.broadcast_enabled IS TRUE THEN 'broadcast' END,
      CASE WHEN EXISTS (SELECT 1 FROM promotions p WHERE p.target_type = 'restaurant' AND p.target_id = rs.id) THEN 'featured' END
    ], NULL) AS modules
  FROM restaurants rs
  WHERE rs.deleted_at IS NULL
),
o AS (
  SELECT
    'organiser'::text AS pro, c.name, c.city, c.status,
    array_remove(ARRAY[
      'reservations',
      CASE WHEN EXISTS (SELECT 1 FROM events e WHERE e.organizer_id = c.id AND (e.payment_mode IN ('payment_only', 'both') OR e.payment_enabled IS TRUE)) THEN 'paid_tickets' END,
      'ticket_control',
      CASE WHEN EXISTS (SELECT 1 FROM vouchers v JOIN events e ON e.id = v.event_id WHERE e.organizer_id = c.id) THEN 'promo_codes' END,
      CASE WHEN EXISTS (SELECT 1 FROM promotions p JOIN events e ON e.id = p.target_id WHERE p.target_type = 'event' AND e.organizer_id = c.id) THEN 'featured' END,
      CASE WHEN c.broadcast_enabled IS TRUE THEN 'broadcast' END,
      CASE WHEN c.event_auto_approve IS TRUE THEN 'auto_approve' END
    ], NULL) AS modules
  FROM customers c
  WHERE EXISTS (SELECT 1 FROM events e WHERE e.organizer_id = c.id)
)
SELECT pro, name, city, status, array_to_string(modules, ', ') AS modules_after FROM r
UNION ALL
SELECT pro, name, city, status, array_to_string(modules, ', ') FROM o
UNION ALL
-- Events with no organiser account (old rows): they keep working as today
-- (bookable, paid if set) — reported here so nothing is a surprise.
SELECT 'event without organiser', title, city, CASE WHEN is_active THEN 'active' ELSE 'inactive' END, '(behaves as today)'
FROM events WHERE organizer_id IS NULL
ORDER BY 1, 2;


-- ════════════════════════════════════════════════════════════════════════════
-- PART 2 — APPLY. Run only after the preview was checked. Safe to re-run.
-- ════════════════════════════════════════════════════════════════════════════
/*  ← delete this line (and the matching one at the end) to run PART 2

-- ── Columns ────────────────────────────────────────────────────────────────
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS modules           text[] NOT NULL DEFAULT '{}';
ALTER TABLE customers   ADD COLUMN IF NOT EXISTS organizer_modules text[] NOT NULL DEFAULT '{}';

DO $$ BEGIN
  ALTER TABLE restaurants ADD CONSTRAINT restaurants_modules_known CHECK (
    modules <@ ARRAY['orders','payment','delivery','team','promo_codes','daily_offer','broadcast','featured','stats']::text[]);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE restaurants ADD CONSTRAINT restaurants_modules_needs_orders CHECK (
    'orders' = ANY(modules) OR NOT (modules && ARRAY['payment','delivery']::text[]));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE customers ADD CONSTRAINT customers_organizer_modules_known CHECK (
    organizer_modules <@ ARRAY['reservations','paid_tickets','ticket_control','promo_codes','featured','broadcast','auto_approve']::text[]);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE customers ADD CONSTRAINT customers_organizer_modules_needs_reservations CHECK (
    'reservations' = ANY(organizer_modules) OR NOT ('paid_tickets' = ANY(organizer_modules)));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Activation requests ("Demander l'activation") ──────────────────────────
CREATE TABLE IF NOT EXISTS module_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type  text NOT NULL CHECK (subject_type IN ('restaurant', 'organizer')),
  restaurant_id uuid REFERENCES restaurants(id) ON DELETE CASCADE,
  customer_id   uuid REFERENCES customers(id)   ON DELETE CASCADE,
  module        text NOT NULL,
  requested_by  uuid REFERENCES customers(id)   ON DELETE SET NULL,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  decided_by    uuid,
  decided_at    timestamptz,
  CONSTRAINT module_requests_subject_ok CHECK (
    (subject_type = 'restaurant' AND restaurant_id IS NOT NULL AND customer_id IS NULL)
 OR (subject_type = 'organizer'  AND customer_id   IS NOT NULL AND restaurant_id IS NULL))
);
-- One pending request per pro and module.
CREATE UNIQUE INDEX IF NOT EXISTS module_requests_one_pending_r ON module_requests (restaurant_id, module) WHERE status = 'pending' AND restaurant_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS module_requests_one_pending_o ON module_requests (customer_id, module)   WHERE status = 'pending' AND customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS module_requests_status ON module_requests (status, created_at DESC);
ALTER TABLE module_requests ENABLE ROW LEVEL SECURITY;   -- server-only

-- ── Platform switches ──────────────────────────────────────────────────────
INSERT INTO platform_settings (key, value) VALUES
  ('restaurants_enabled', 'true'::jsonb),
  ('events_enabled',      'true'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ── Backfill (same rules as the preview). Only rows still on '{}' are
--    touched, so a re-run never undoes a later admin change. ─────────────────
UPDATE restaurants rs SET modules = array_remove(ARRAY[
    'orders',
    CASE WHEN rs.payment_mode IN ('payment_only', 'both') OR rs.whatsapp_payment_enabled IS TRUE THEN 'payment' END,
    CASE WHEN rs.delivery_enabled IS TRUE THEN 'delivery' END,
    CASE WHEN EXISTS (SELECT 1 FROM restaurant_team t WHERE t.restaurant_id = rs.id AND t.role <> 'owner' AND t.status IN ('active', 'pending'))
           OR EXISTS (SELECT 1 FROM team_invitations i WHERE i.restaurant_id = rs.id) THEN 'team' END,
    CASE WHEN EXISTS (SELECT 1 FROM vouchers v WHERE v.restaurant_id = rs.id) THEN 'promo_codes' END,
    CASE WHEN EXISTS (SELECT 1 FROM menu_offers o WHERE o.restaurant_id = rs.id) THEN 'daily_offer' END,
    CASE WHEN rs.broadcast_enabled IS TRUE THEN 'broadcast' END,
    CASE WHEN EXISTS (SELECT 1 FROM promotions p WHERE p.target_type = 'restaurant' AND p.target_id = rs.id) THEN 'featured' END
  ], NULL)
WHERE rs.modules = '{}';

UPDATE customers c SET organizer_modules = array_remove(ARRAY[
    'reservations',
    CASE WHEN EXISTS (SELECT 1 FROM events e WHERE e.organizer_id = c.id AND (e.payment_mode IN ('payment_only', 'both') OR e.payment_enabled IS TRUE)) THEN 'paid_tickets' END,
    'ticket_control',
    CASE WHEN EXISTS (SELECT 1 FROM vouchers v JOIN events e ON e.id = v.event_id WHERE e.organizer_id = c.id) THEN 'promo_codes' END,
    CASE WHEN EXISTS (SELECT 1 FROM promotions p JOIN events e ON e.id = p.target_id WHERE p.target_type = 'event' AND e.organizer_id = c.id) THEN 'featured' END,
    CASE WHEN c.broadcast_enabled IS TRUE THEN 'broadcast' END,
    CASE WHEN c.event_auto_approve IS TRUE THEN 'auto_approve' END
  ], NULL)
WHERE c.organizer_modules = '{}'
  AND EXISTS (SELECT 1 FROM events e WHERE e.organizer_id = c.id);

-- MeResto also gets Livraison (asked for, to test delivery on it). It still
-- needs "Livraison activée" + a fee in its dashboard settings to deliver.
UPDATE restaurants
   SET modules = modules || ARRAY['delivery']
 WHERE id = '854381d6-e295-4cf0-8522-089b049f626e'
   AND NOT ('delivery' = ANY(modules));

NOTIFY pgrst, 'reload schema';

-- ── Check ──────────────────────────────────────────────────────────────────
-- SELECT name, modules FROM restaurants WHERE deleted_at IS NULL ORDER BY name;          -- matches the preview
-- SELECT name, organizer_modules FROM customers WHERE organizer_modules <> '{}' ORDER BY name;
-- SELECT key, value FROM platform_settings WHERE key IN ('restaurants_enabled','events_enabled');  -- 2 rows, true
-- SELECT count(*) FROM module_requests;                                                  -- 0

← delete this line too */
