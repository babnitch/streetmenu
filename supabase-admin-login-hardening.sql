-- Team / admin login hardening. Safe to re-run.
-- Needs supabase-auth-login-limits.sql (already applied).
--
--   admin_users.phone        where the team member's login code is sent.
--   admin_login_challenges   pending codes after a correct password (kept apart
--                            from customer codes on purpose: a customer code
--                            must never open a team account).
--   admin_login_attempts     every team login attempt, success or failure.
--   admin_login_lock()       5 failures in 15 min for one email OR one IP →
--                            locked until 15 min after the last failure.
--   auth_code_sends.purpose  'customer' | 'team'. Team codes keep the
--                            per-number and per-IP limits but don't count
--                            against, and aren't blocked by, the platform's
--                            daily cap.

-- ── Team phone ──────────────────────────────────────────────────────────────
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS phone text;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'admin_users_phone_format') THEN
    ALTER TABLE admin_users ADD CONSTRAINT admin_users_phone_format
      CHECK (phone IS NULL OR phone ~ '^\+[0-9]{6,15}$');
  END IF;
END $$;

-- ── Pending codes ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS admin_login_challenges (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id   uuid NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  code       text NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts   int NOT NULL DEFAULT 0,
  used       boolean NOT NULL DEFAULT false,
  ip         text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS admin_login_challenges_admin_idx ON admin_login_challenges (admin_id, created_at DESC);
ALTER TABLE admin_login_challenges ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON admin_login_challenges FROM anon, authenticated;

-- ── Attempts log ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS admin_login_attempts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email      text NOT NULL,
  ip         text,
  admin_id   uuid,
  stage      text NOT NULL CHECK (stage IN ('password', 'code')),
  success    boolean NOT NULL,
  -- failures: unknown_email | bad_password | suspended | no_phone | bad_code |
  --           code_expired | code_locked | locked (attempt refused while locked)
  reason     text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS admin_login_attempts_email_idx   ON admin_login_attempts (lower(trim(email)), created_at DESC);
CREATE INDEX IF NOT EXISTS admin_login_attempts_ip_idx      ON admin_login_attempts (ip, created_at DESC);
CREATE INDEX IF NOT EXISTS admin_login_attempts_created_idx ON admin_login_attempts (created_at DESC);
ALTER TABLE admin_login_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON admin_login_attempts FROM anon, authenticated;

INSERT INTO platform_settings (key, value) VALUES
  ('admin_login_max_failures',    '5'),    -- failures before the lock
  ('admin_login_lock_minutes',    '15'),   -- window and lock length
  ('admin_login_alert_minutes',   '60')    -- at most 1 WhatsApp alert per email / IP per this
ON CONFLICT (key) DO NOTHING;

-- Locked? Failures (refused-while-locked attempts excluded) in the last
-- window, per email and per IP. Returns { locked, retry_after (s), by }.
CREATE OR REPLACE FUNCTION admin_login_lock(p_email text, p_ip text)
RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_max  int := platform_setting_int('admin_login_max_failures', 5);
  v_min  int := platform_setting_int('admin_login_lock_minutes', 15);
  v_ip   text := NULLIF(NULLIF(p_ip, ''), 'unknown');
  v_n    int;
  v_last timestamptz;
BEGIN
  SELECT count(*), max(created_at) INTO v_n, v_last FROM admin_login_attempts
    WHERE lower(trim(email)) = lower(trim(p_email)) AND NOT success AND reason IS DISTINCT FROM 'locked'
      AND created_at > now() - make_interval(mins => v_min);
  IF v_n >= v_max THEN
    RETURN jsonb_build_object('locked', true, 'by', 'email',
      'retry_after', GREATEST(ceil(extract(epoch FROM (v_last + make_interval(mins => v_min) - now())))::int, 1));
  END IF;
  IF v_ip IS NOT NULL THEN
    SELECT count(*), max(created_at) INTO v_n, v_last FROM admin_login_attempts
      WHERE ip = v_ip AND NOT success AND reason IS DISTINCT FROM 'locked'
        AND created_at > now() - make_interval(mins => v_min);
    IF v_n >= v_max THEN
      RETURN jsonb_build_object('locked', true, 'by', 'ip',
        'retry_after', GREATEST(ceil(extract(epoch FROM (v_last + make_interval(mins => v_min) - now())))::int, 1));
    END IF;
  END IF;
  RETURN jsonb_build_object('locked', false);
END $$;

-- ── Team codes outside the daily cap ────────────────────────────────────────
ALTER TABLE auth_code_sends ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'customer';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'auth_code_sends_purpose_check') THEN
    ALTER TABLE auth_code_sends ADD CONSTRAINT auth_code_sends_purpose_check CHECK (purpose IN ('customer', 'team'));
  END IF;
END $$;

-- Same function as before plus p_purpose. The old 4-argument version is
-- replaced (existing calls keep working: p_purpose defaults to 'customer').
DROP FUNCTION IF EXISTS auth_code_claim(text, text, text, boolean);
CREATE OR REPLACE FUNCTION auth_code_claim(p_phone text, p_ip text, p_channel text, p_fallback boolean DEFAULT false, p_purpose text DEFAULT 'customer')
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_gap     int := platform_setting_int('auth_code_resend_seconds', 30);
  v_phone_h int := platform_setting_int('auth_code_phone_hourly', 5);
  v_ip_h    int := platform_setting_int('auth_code_ip_hourly', 20);
  v_cap     int := platform_setting_int('auth_codes_daily_cap', 40);
  v_ip      text := NULLIF(NULLIF(p_ip, ''), 'unknown');
  v_purpose text := CASE WHEN p_purpose = 'team' THEN 'team' ELSE 'customer' END;
  v_last    timestamptz;
  v_oldest  timestamptz;
  v_count   int;
  v_reason  text;
  v_retry   int;
  v_id      uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('auth_code_claim'));

  IF NOT p_fallback THEN
    SELECT max(created_at) INTO v_last FROM auth_code_sends
      WHERE phone = p_phone AND status IN ('sent', 'failed');
    IF v_last IS NOT NULL AND v_last > now() - make_interval(secs => v_gap) THEN
      v_reason := 'resend_cooldown';
      v_retry  := ceil(extract(epoch FROM (v_last + make_interval(secs => v_gap) - now())))::int;
    END IF;
  END IF;

  IF v_reason IS NULL THEN
    SELECT count(*), min(created_at) INTO v_count, v_oldest FROM auth_code_sends
      WHERE phone = p_phone AND status IN ('sent', 'failed') AND created_at > now() - interval '1 hour';
    IF v_count >= v_phone_h THEN
      v_reason := 'phone_hourly';
      v_retry  := ceil(extract(epoch FROM (v_oldest + interval '1 hour' - now())))::int;
    END IF;
  END IF;

  IF v_reason IS NULL AND v_ip IS NOT NULL THEN
    SELECT count(*), min(created_at) INTO v_count, v_oldest FROM auth_code_sends
      WHERE ip = v_ip AND status IN ('sent', 'failed') AND created_at > now() - interval '1 hour';
    IF v_count >= v_ip_h THEN
      v_reason := 'ip_hourly';
      v_retry  := ceil(extract(epoch FROM (v_oldest + interval '1 hour' - now())))::int;
    END IF;
  END IF;

  -- The platform's daily cap: customer codes only.
  IF v_reason IS NULL AND v_purpose = 'customer' THEN
    SELECT count(*), min(created_at) INTO v_count, v_oldest FROM auth_code_sends
      WHERE purpose = 'customer' AND status IN ('sent', 'failed') AND created_at > now() - interval '24 hours';
    IF v_count >= v_cap THEN
      v_reason := 'daily_cap';
      v_retry  := ceil(extract(epoch FROM (v_oldest + interval '24 hours' - now())))::int;
    END IF;
  END IF;

  IF v_reason IS NOT NULL THEN
    INSERT INTO auth_code_sends (phone, ip, channel, status, reason, purpose)
      VALUES (p_phone, v_ip, p_channel, 'blocked', v_reason, v_purpose);
    RETURN jsonb_build_object('ok', false, 'reason', v_reason, 'retry_after', GREATEST(v_retry, 1));
  END IF;

  INSERT INTO auth_code_sends (phone, ip, channel, status, purpose)
    VALUES (p_phone, v_ip, p_channel, 'sent', v_purpose)
    RETURNING id INTO v_id;
  RETURN jsonb_build_object('ok', true, 'send_id', v_id);
END $$;

-- Server only.
REVOKE ALL ON FUNCTION auth_code_claim(text, text, text, boolean, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION admin_login_lock(text, text)                     FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION auth_code_claim(text, text, text, boolean, text) TO service_role;
GRANT EXECUTE ON FUNCTION admin_login_lock(text, text)                     TO service_role;
GRANT ALL ON admin_login_challenges, admin_login_attempts TO service_role;

NOTIFY pgrst, 'reload schema';

-- ── Then: your phone (REQUIRED, or you can't log in as admin) ───────────────
-- UPDATE admin_users SET phone = '+41XXXXXXXXX' WHERE email = 'you@example.com';
--
-- Checks:
-- SELECT email, role, phone IS NOT NULL AS has_phone FROM admin_users;          -- your row: true
-- SELECT key, value FROM platform_settings WHERE key LIKE 'admin_login%';        -- 3 rows
-- SELECT has_function_privilege('anon', 'admin_login_lock(text,text)', 'EXECUTE');  -- false


-- ════════════════════════════════════════════════════════════════════════════
-- RECOVERY — if you are ever locked out. Run in the Supabase SQL Editor
-- (it uses the service role; the app's limits don't apply there).
-- Replace the email / phone / password placeholders.
-- ════════════════════════════════════════════════════════════════════════════
--
-- A. "Connexion bloquée 15 min" — clear the failures (by email, or by IP):
--    DELETE FROM admin_login_attempts WHERE email = 'you@example.com' AND NOT success;
--    DELETE FROM admin_login_attempts WHERE ip = '1.2.3.4' AND NOT success;
--
-- B. The code never arrives / "trop de codes" — clear the recent sends to
--    your number (removes the 30 s / hourly limits for it):
--    DELETE FROM auth_code_sends WHERE phone = '+41XXXXXXXXX' AND created_at > now() - interval '1 hour';
--    …and check WhatsApp/SMS delivery in Admin → Messages, or Twilio's console.
--
-- C. Lost or changed phone — point the code to a number you have:
--    UPDATE admin_users SET phone = '+41XXXXXXXXX' WHERE email = 'you@example.com';
--
-- D. Forgotten password — set a new one (bcrypt, same format the app checks):
--    UPDATE admin_users
--       SET password_hash = extensions.crypt('NEW-LONG-PASSWORD', extensions.gen_salt('bf', 10))
--     WHERE email = 'you@example.com';
--    (If "function crypt does not exist": run CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions; first.)
--
-- E. Account suspended by mistake:
--    UPDATE admin_users SET status = 'active' WHERE email = 'you@example.com';
--
-- F. See what happened (most recent first):
--    SELECT created_at, email, ip, stage, success, reason FROM admin_login_attempts ORDER BY created_at DESC LIMIT 50;
--
-- G. Pending codes (to read a code yourself if no message arrives at all —
--    only the latest unused one counts, valid 10 minutes):
--    SELECT c.code, c.expires_at, c.attempts FROM admin_login_challenges c
--      JOIN admin_users a ON a.id = c.admin_id
--     WHERE a.email = 'you@example.com' AND NOT c.used ORDER BY c.created_at DESC LIMIT 1;
