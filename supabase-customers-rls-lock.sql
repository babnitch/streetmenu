-- =============================================================================
-- customers — lock to service-role (Phase 1 of the anon-read RLS fix)
-- =============================================================================
-- Run in the Supabase SQL editor AFTER this deploy is verified — the admin
-- Restaurants owner name/phone must still render first. Breaks the owner block
-- SILENTLY if run early.
--
-- "Silently" is the whole reason this file is not applied by the same commit
-- that ships the code. app/admin/restaurants/page.tsx reads restaurants with
-- an embedded FK join to customers. PostgREST applies RLS to the JOINED table
-- independently, so a deny policy does not raise an error — it returns
-- owner = null, and the card renders with an empty owner line. Nothing logs,
-- nothing 500s, and the only way to notice is to look at the panel.
--
-- WHAT IS BEING FIXED. `customers` is currently readable in full by the
-- public anon key, which ships in the browser bundle. Anyone can pull all
-- rows:
--
--   phone, name, momo_phone (mobile-money account identifier), city,
--   suspension_reason, suspended_by, broadcast_blocked, nickname
--
-- The permissive policy comes from the original WhatsApp onboarding
-- migration, which predates the JWT session layer:
--
--   supabase-whatsapp-onboarding.sql:15
--     CREATE POLICY "customers_select" ON customers FOR SELECT USING (true);
--
-- supabase-rls-policies.sql already INTENDS service-role-only for this table
-- (section 10). That file has never been run — it is one BEGIN/COMMIT covering
-- many tables and would lock `orders` at the same time, which is Phase 2 and
-- has two browser readers still to migrate. This file does the customers half
-- alone, so the phases stay independently deployable and independently
-- revertible.
--
-- WHY THIS IS SAFE NOW. `customers` has ZERO direct browser reads — verified
-- by sweeping every anon-client consumer (static and dynamic imports of
-- lib/supabase.ts) across app/, components/ and lib/. Every other read of the
-- table is already server-side through supabaseAdmin, which uses the service
-- role and bypasses RLS: app/api/auth/*, app/api/admin/*, app/api/events/*,
-- app/api/whatsapp/incoming, lib/releaseAccount.ts, lib/whatsapp.ts,
-- lib/promotions.ts, lib/subscriptions.ts and the rest. The single indirect
-- reader was the FK join above, moved to GET /api/admin/restaurants in the
-- commit that ships alongside this file.
--
-- WRITES ARE UNTOUCHED. customers_insert and customers_update stay exactly as
-- they are. This changes SELECT only. Narrowing the write policies is a
-- separate question with a separate blast radius — signup and profile edits
-- run through them — and bundling it here would put two different rollbacks
-- behind one statement.
--
-- VERIFY BEFORE RUNNING (all must be true):
--   1. The deploy carrying GET /api/admin/restaurants is live.
--   2. As an admin, open /account → Restaurants. Every card that has an owner
--      still shows the owner line (👤 name · phone). If any card that had an
--      owner now shows none, STOP — do not run this.
--   3. npm run test:release is green.
--
-- VERIFY AFTER RUNNING:
--   1. Reload the admin Restaurants panel. Owner name/phone still render
--      (they now come from the server route, which bypasses RLS).
--   2. npm run test:release — db-schema-migrations should now FAIL with
--      "customers: locked — Phase 1 IS COMPLETE: promote this entry".
--      That failure is the SUCCESS signal: it means the register measured the
--      lock landing. Promote the entry in scripts/suites/db-schema-migrations.ts
--      (set current: 'locked' for 'customers' in RLS_EXPECTATIONS, drop the
--      phase note) and the suite returns to green with the guarantee now
--      pinned as a hard assertion.
--   3. Sign up a new customer over WhatsApp, and log in as an existing one.
--      Both paths write and read through supabaseAdmin and must be unaffected.
--
-- TO ROLL BACK:
--   CREATE POLICY "customers_select" ON customers FOR SELECT USING (true);
--
-- Idempotent — safe to re-run.
-- =============================================================================

BEGIN;

ALTER TABLE customers ENABLE ROW LEVEL SECURITY;

-- The permissive read from supabase-whatsapp-onboarding.sql. Dropping it is
-- the entire change: with RLS enabled and no SELECT policy remaining, anon and
-- authenticated get nothing, while the service-role key continues to bypass
-- RLS altogether.
DROP POLICY IF EXISTS "customers_select" ON customers;

-- Named alternatives seen across earlier migrations, dropped defensively so a
-- differently-named permissive read cannot survive this and leave the table
-- open while the register reports it locked.
DROP POLICY IF EXISTS "Public can read customers" ON customers;
DROP POLICY IF EXISTS "public_read"               ON customers;
DROP POLICY IF EXISTS "customers_public_read"     ON customers;

COMMIT;

-- Confirm — expect ZERO rows. Any row returned is a SELECT policy still
-- granting anon access, and the table is NOT locked.
--
--   SELECT policyname, cmd, roles
--   FROM pg_policies
--   WHERE schemaname = 'public' AND tablename = 'customers' AND cmd = 'SELECT';
--
-- And expect customers_insert / customers_update to still be listed:
--
--   SELECT policyname, cmd FROM pg_policies
--   WHERE schemaname = 'public' AND tablename = 'customers';
