-- =============================================================================
-- signup_sessions.user_type — widen for menu_category + invite_accept
-- =============================================================================
-- The router writes SEVEN user_type values; the CHECK constraint only ever
-- allowed five. It was widened twice before and both times missed a value that
-- had already shipped in code:
--
--   supabase-whatsapp-onboarding.sql      'customer', 'vendor'
--   supabase-restaurant-photos.sql        + 'photo_update'
--   supabase-orders-cancelled-status.sql  + 'restaurant_select', 'ordering'
--
-- The two missing values break two flows OUTRIGHT, and silently, because none
-- of the five upserts checked its error (fixed alongside this migration in
-- app/api/whatsapp/incoming/route.ts):
--
--   menu_category  — the 2-part "Ndolé - 2500" add-item flow and the
--                    unrecognised-category prompt, in BOTH the text and the
--                    photo-caption paths (4 call sites). The 3-part form
--                    "Ndolé - 2500 - Plats" works, which is why this went
--                    unnoticed: the vendor is asked to pick a category, picks
--                    one, and the item is never created.
--   invite_accept  — an invitee who is NOT yet a customer replying "accepter".
--                    The session carrying their invitation IDs was never
--                    written, so the registration never completed and the
--                    invitation was orphaned. This is the likely cause of
--                    previously-observed invitations that were never accepted.
--
-- A regression guard lives in scripts/suites/db-schema-migrations.ts: it
-- asserts every value the router writes is accepted by this constraint, and
-- FAILS HARD (never a warn) if they diverge again. That suite is expected to
-- be RED until this migration is applied — that red is the signal, not a bug.
--
-- Run in the Supabase SQL editor after review. Idempotent — safe to re-run.
-- =============================================================================

ALTER TABLE signup_sessions DROP CONSTRAINT IF EXISTS signup_sessions_user_type_check;

ALTER TABLE signup_sessions ADD CONSTRAINT signup_sessions_user_type_check
  CHECK (user_type IN (
    'customer',
    'vendor',
    'photo_update',
    'restaurant_select',
    'ordering',
    'menu_category',
    'invite_accept'
  ));
