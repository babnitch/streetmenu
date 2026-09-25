-- Payment reconcile cron — Supabase pg_cron → pg_net → POST /api/payments/reconcile
--
-- Every 10 minutes, asks the app to settle PawaPay deposits still pending
-- 10 min – 48 h after they started (lib/payments-reconcile.ts). The safety
-- net for lost / rejected callbacks, and the ONLY recovery path for WhatsApp
-- payments, which nothing else polls.
--
-- Requires: pg_cron, pg_net, supabase_vault (Database → Extensions).
-- Run in the Supabase SQL Editor. Deploy the app code FIRST — until
-- /api/payments/reconcile exists the job just gets 404s.
--
-- The bearer secret lives in Vault (encrypted at rest), NOT in the job text:
-- cron.job.command is readable by anyone who can read that table.

-- ── 1. Secrets (run once; paste the real value, never commit it) ─────────────
-- The SAME value as INTERNAL_API_SECRET in Vercel → Production.
select vault.create_secret('<paste INTERNAL_API_SECRET here>', 'internal_api_secret',
  'Bearer for /api/payments/reconcile (must equal Vercel INTERNAL_API_SECRET)');
select vault.create_secret('https://streetmenu.vercel.app/api/payments/reconcile', 'reconcile_url',
  'Target of the pawapay-reconcile cron job');

-- If INTERNAL_API_SECRET is ever rotated in Vercel, update Vault too or the
-- job starts getting 401s:
--   select vault.update_secret(
--     (select id from vault.secrets where name = 'internal_api_secret'),
--     '<new value>');

-- ── 2. The job ───────────────────────────────────────────────────────────────
-- timeout_milliseconds: pg_net's 5s default would cut the request mid-run
-- (up to 25 PawaPay checks); the route itself allows 60s.
select cron.schedule(
  'pawapay-reconcile',
  '*/10 * * * *',
  $$
  select net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets where name = 'reconcile_url'),
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'internal_api_secret')
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);

-- ── 3. Checking it ───────────────────────────────────────────────────────────
-- Did the job run?
--   select jobid, status, return_message, start_time
--     from cron.job_run_details
--    where jobid = (select jobid from cron.job where jobname = 'pawapay-reconcile')
--    order by start_time desc limit 5;
--
-- What did the app answer? (200 + {"ok":true,"checked":…}; 401 = secret
-- mismatch; 503 = INTERNAL_API_SECRET unset on Vercel)
--   select created, status_code, left(content::text, 300) as body
--     from net._http_response order by created desc limit 5;
--
-- ── 4. Stopping it ───────────────────────────────────────────────────────────
--   select cron.unschedule('pawapay-reconcile');
