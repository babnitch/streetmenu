-- =============================================================================
-- Row Level Security policies — replace the early USING(false) stubs
-- Run this in Supabase SQL Editor
-- =============================================================================
-- Two policy shapes used throughout:
--
--   public_select_active(table_name, predicate)
--      The anon Supabase client can SELECT rows that match `predicate`.
--      Used for genuinely public surfaces — restaurants the user is
--      browsing, public menus, events, ratings, etc.
--
--   service_only(table_name)
--      No anon access. Reads + writes must go through the server-side
--      service-role client. Used for anything tied to a single
--      customer (orders, vouchers, reservations, subscriptions),
--      anything moderation-relevant (reports, audit, broadcasts), or
--      anything carrying secrets (verification_codes, signup_sessions).
--
-- We don't use Supabase Auth for customer identity (our own JWT does
-- that), so "SELECT own rows" policies can't reference auth.uid().
-- Customer-private reads instead go through API routes that use
-- supabaseAdmin → bypass RLS while still enforcing per-customer
-- authorization in code.
--
-- Idempotent — every policy is created via DROP IF EXISTS + CREATE.
-- =============================================================================

BEGIN;

-- Helper: replace any existing policy named `policyname` on `table_name`
-- with a fresh definition. Postgres has no CREATE POR REPLACE POLICY, so
-- the DROP-then-CREATE pattern keeps reruns clean.
-- (Inlined per-table below to avoid an admin helper function.)

-- ────────────────────────────────────────────────────────────────────────────
-- 1. RESTAURANTS — public list + detail, mutations via service role
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE restaurants ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_only"  ON restaurants;
DROP POLICY IF EXISTS "public_active_read" ON restaurants;
CREATE POLICY "public_active_read" ON restaurants
  FOR SELECT TO anon, authenticated
  USING (
    is_active = TRUE
    AND status IN ('active', 'approved')
    AND deleted_at IS NULL
  );

-- ────────────────────────────────────────────────────────────────────────────
-- 2. MENU_ITEMS — public when the parent restaurant is visible
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE menu_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_only" ON menu_items;
DROP POLICY IF EXISTS "public_read"       ON menu_items;
CREATE POLICY "public_read" ON menu_items
  FOR SELECT TO anon, authenticated
  USING (
    EXISTS (
      SELECT 1 FROM restaurants r
       WHERE r.id = menu_items.restaurant_id
         AND r.is_active = TRUE
         AND r.status IN ('active', 'approved')
         AND r.deleted_at IS NULL
    )
  );

-- ────────────────────────────────────────────────────────────────────────────
-- 3. RESTAURANT_HOURS — public read, service-only writes
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE restaurant_hours ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_only" ON restaurant_hours;
DROP POLICY IF EXISTS "public_read"       ON restaurant_hours;
CREATE POLICY "public_read" ON restaurant_hours
  FOR SELECT TO anon, authenticated USING (TRUE);

-- ────────────────────────────────────────────────────────────────────────────
-- 4. RESTAURANT_RATINGS — public read of all visible ratings
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE restaurant_ratings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_only" ON restaurant_ratings;
DROP POLICY IF EXISTS "public_read"       ON restaurant_ratings;
CREATE POLICY "public_read" ON restaurant_ratings
  FOR SELECT TO anon, authenticated USING (TRUE);

-- ────────────────────────────────────────────────────────────────────────────
-- 5. EVENTS — public when active
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_only" ON events;
DROP POLICY IF EXISTS "public_active_read" ON events;
CREATE POLICY "public_active_read" ON events
  FOR SELECT TO anon, authenticated
  USING (is_active = TRUE);

-- ────────────────────────────────────────────────────────────────────────────
-- 6. EVENT_LIKES + EVENT_COMMENTS — public reads (comments hide deleted)
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE event_likes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_only" ON event_likes;
DROP POLICY IF EXISTS "public_read"       ON event_likes;
CREATE POLICY "public_read" ON event_likes
  FOR SELECT TO anon, authenticated USING (TRUE);

ALTER TABLE event_comments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_only" ON event_comments;
DROP POLICY IF EXISTS "public_read"       ON event_comments;
CREATE POLICY "public_read" ON event_comments
  FOR SELECT TO anon, authenticated
  USING (COALESCE(is_deleted, FALSE) = FALSE);

-- ────────────────────────────────────────────────────────────────────────────
-- 7. EVENT_TICKET_TIERS — public read, service-only writes
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE event_ticket_tiers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_only" ON event_ticket_tiers;
DROP POLICY IF EXISTS "public_read"       ON event_ticket_tiers;
CREATE POLICY "public_read" ON event_ticket_tiers
  FOR SELECT TO anon, authenticated USING (TRUE);

-- ────────────────────────────────────────────────────────────────────────────
-- 8. VOUCHERS — public read of active codes (the apply UI needs this)
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE vouchers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_only" ON vouchers;
DROP POLICY IF EXISTS "public_active_read" ON vouchers;
CREATE POLICY "public_active_read" ON vouchers
  FOR SELECT TO anon, authenticated
  USING (is_active = TRUE);

-- ────────────────────────────────────────────────────────────────────────────
-- 9. BROADCAST_PRICING + PROMOTION_PRICING — public so the composer
--    can render the rate sheet client-side without a roundtrip.
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE broadcast_pricing ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_only" ON broadcast_pricing;
DROP POLICY IF EXISTS "public_read"       ON broadcast_pricing;
CREATE POLICY "public_read" ON broadcast_pricing
  FOR SELECT TO anon, authenticated USING (is_active = TRUE);

ALTER TABLE promotion_pricing ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_only" ON promotion_pricing;
DROP POLICY IF EXISTS "public_read"       ON promotion_pricing;
CREATE POLICY "public_read" ON promotion_pricing
  FOR SELECT TO anon, authenticated USING (is_active = TRUE);

-- ────────────────────────────────────────────────────────────────────────────
-- 10. EVERYTHING ELSE — service-role only.
--     The anon client can't read or write any of these tables. Customer-
--     specific reads must go through API routes that authenticate via
--     our JWT and use supabaseAdmin (which bypasses RLS).
-- ────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'customers',
    'admin_users',
    'restaurant_team',
    'team_invitations',
    'orders',
    'order_items',
    'customer_vouchers',
    'event_reservations',
    'event_subscriptions',
    'broadcasts',
    'promotions',
    'reports',
    'audit_log',
    'verification_codes',
    'signup_sessions'
  ])
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS "service_role_only" ON %I', t);
    EXECUTE format('DROP POLICY IF EXISTS "public_read"       ON %I', t);
    EXECUTE format(
      'CREATE POLICY "service_role_only" ON %I USING (FALSE) WITH CHECK (FALSE)',
      t
    );
  END LOOP;
END $$;

COMMIT;
