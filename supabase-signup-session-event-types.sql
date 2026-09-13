-- =============================================================================
-- signup_sessions.user_type — widen for the WhatsApp event + reservation flows
-- =============================================================================
-- The WhatsApp handlers write ELEVEN user_type values; the CHECK constraint
-- allows seven. The four missing ones have been in code since the events flow
-- shipped (98d9865, "WhatsApp events: full browse → reserve → pay flow") and
-- are written from lib/whatsapp/ordering.ts, not the router:
--
--   event_browse         — "evenements": the numbered event list
--   event_detail         — picking an event from that list
--   event_reserve        — every step of in-chat booking: quantity, promo
--                          code, pay-now vs reserve, Mobile Money number
--   reservations_browse  — "mes reservations": the numbered reservation list
--
-- All four broke their flows OUTRIGHT, and silently, the same way
-- menu_category and invite_accept did (supabase-signup-session-types.sql):
-- the session save was rejected by this constraint, nobody checked the error,
-- and the customer still got the friendly prompt. Every answer to that prompt
-- then went nowhere — so no WhatsApp event reservation could ever be created.
-- The web reserve/pay APIs do not use signup_sessions and were unaffected.
--
-- Why the earlier regression guard missed it: it scanned only
-- app/api/whatsapp/incoming/route.ts for user_type literals. It now scans
-- lib/whatsapp/ too (scripts/suites/db-schema-migrations.ts), and the saves in
-- ordering.ts now check their error and log it instead of prompting.
--
-- That suite is expected to be RED until this migration is applied — that red
-- is the signal, not a bug.
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
    'invite_accept',
    'event_browse',
    'event_detail',
    'event_reserve',
    'reservations_browse'
  ));
