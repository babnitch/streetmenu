-- Login codes: limits in the database (L1).
--
-- Replaces the in-memory limits of /api/auth/send-code and verify-code,
-- which multiplied across Vercel servers. Everything here is reached only by
-- the server (service_role); anon / authenticated get nothing.
--
--   platform_settings   small key → value table; the login limits live here
--                       so they can be changed with one UPDATE, no deploy.
--   auth_code_sends     one row per code send attempt — sent, failed or
--                       blocked (and why). The admin "Codes de connexion" log.
--   auth_code_claim()   atomically checks every send limit and records the
--                       attempt: 30 s between sends per phone, per phone per
--                       hour, per IP per hour, and a GLOBAL cap per 24 h
--                       (protects against SMS pumping and the Twilio trial
--                       cap). Blocked attempts are logged too.
--   verification_codes.attempts + auth_code_check(): a code dies after 5
--                       wrong tries, counted in the database.
--
-- Safe to re-run.

-- ── Settings ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS platform_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE platform_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON platform_settings FROM anon, authenticated;

INSERT INTO platform_settings (key, value) VALUES
  ('auth_codes_daily_cap',      '40'),   -- codes sent by the whole platform per 24 h
  ('auth_code_resend_seconds',  '30'),   -- minimum gap between two sends to one phone
  ('auth_code_phone_hourly',    '5'),    -- sends per phone per hour
  ('auth_code_ip_hourly',       '20'),   -- sends per IP per hour
  ('auth_code_max_attempts',    '5')     -- wrong tries before a code dies
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION platform_setting_int(p_key text, p_default int)
RETURNS int LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT (value #>> '{}')::int FROM platform_settings WHERE key = p_key), p_default)
$$;

-- ── Send log ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS auth_code_sends (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone      text NOT NULL,
  ip         text,
  channel    text NOT NULL CHECK (channel IN ('whatsapp', 'sms')),
  status     text NOT NULL CHECK (status IN ('sent', 'failed', 'blocked')),
  reason     text,          -- blocked: resend_cooldown | phone_hourly | ip_hourly | daily_cap
                            -- failed:  the provider error (e.g. 63038)
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_code_sends_phone_idx   ON auth_code_sends (phone, created_at DESC);
CREATE INDEX IF NOT EXISTS auth_code_sends_ip_idx      ON auth_code_sends (ip, created_at DESC);
CREATE INDEX IF NOT EXISTS auth_code_sends_created_idx ON auth_code_sends (created_at DESC);
ALTER TABLE auth_code_sends ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON auth_code_sends FROM anon, authenticated;

-- Checks every limit and records the attempt, under one lock so two
-- simultaneous requests can't both slip under a limit. Attempts that reached
-- the provider ('sent' and 'failed') count; 'blocked' ones don't.
--
-- p_fallback: the SMS retry right after a failed WhatsApp send for the same
-- login. It skips the 30 s gap (the WhatsApp attempt just happened) but still
-- counts against every other limit.
--
-- Returns { ok, send_id } or { ok:false, reason, retry_after (seconds) }.
CREATE OR REPLACE FUNCTION auth_code_claim(p_phone text, p_ip text, p_channel text, p_fallback boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_gap     int := platform_setting_int('auth_code_resend_seconds', 30);
  v_phone_h int := platform_setting_int('auth_code_phone_hourly', 5);
  v_ip_h    int := platform_setting_int('auth_code_ip_hourly', 20);
  v_cap     int := platform_setting_int('auth_codes_daily_cap', 40);
  v_ip      text := NULLIF(NULLIF(p_ip, ''), 'unknown');
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

  IF v_reason IS NULL THEN
    SELECT count(*), min(created_at) INTO v_count, v_oldest FROM auth_code_sends
      WHERE status IN ('sent', 'failed') AND created_at > now() - interval '24 hours';
    IF v_count >= v_cap THEN
      v_reason := 'daily_cap';
      v_retry  := ceil(extract(epoch FROM (v_oldest + interval '24 hours' - now())))::int;
    END IF;
  END IF;

  IF v_reason IS NOT NULL THEN
    INSERT INTO auth_code_sends (phone, ip, channel, status, reason)
      VALUES (p_phone, v_ip, p_channel, 'blocked', v_reason);
    RETURN jsonb_build_object('ok', false, 'reason', v_reason, 'retry_after', GREATEST(v_retry, 1));
  END IF;

  INSERT INTO auth_code_sends (phone, ip, channel, status)
    VALUES (p_phone, v_ip, p_channel, 'sent')
    RETURNING id INTO v_id;
  RETURN jsonb_build_object('ok', true, 'send_id', v_id);
END $$;

-- ── Code attempts ───────────────────────────────────────────────────────────
ALTER TABLE verification_codes ADD COLUMN IF NOT EXISTS attempts int NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS verification_codes_phone_idx ON verification_codes (phone);

-- Checks a typed code against the phone's latest unused code, under a row
-- lock. A wrong code adds an attempt; at the limit the code is dead.
-- Returns { result: ok | wrong | expired | locked | none, attempts_left }.
CREATE OR REPLACE FUNCTION auth_code_check(p_phone text, p_code text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_max int := platform_setting_int('auth_code_max_attempts', 5);
  r     verification_codes%ROWTYPE;
BEGIN
  SELECT * INTO r FROM verification_codes
    WHERE phone = p_phone AND used = false
    ORDER BY created_at DESC LIMIT 1
    FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'none');
  END IF;
  IF r.expires_at < now() THEN
    RETURN jsonb_build_object('result', 'expired');
  END IF;
  IF r.attempts >= v_max THEN
    RETURN jsonb_build_object('result', 'locked');
  END IF;
  IF r.code <> p_code THEN
    UPDATE verification_codes SET attempts = attempts + 1 WHERE id = r.id;
    RETURN jsonb_build_object('result', CASE WHEN r.attempts + 1 >= v_max THEN 'locked' ELSE 'wrong' END,
                              'attempts_left', GREATEST(v_max - r.attempts - 1, 0));
  END IF;
  UPDATE verification_codes SET used = true WHERE id = r.id;
  RETURN jsonb_build_object('result', 'ok');
END $$;

-- Server only.
REVOKE ALL ON FUNCTION platform_setting_int(text, int)                FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION auth_code_claim(text, text, text, boolean)     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION auth_code_check(text, text)                    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION platform_setting_int(text, int)             TO service_role;
GRANT EXECUTE ON FUNCTION auth_code_claim(text, text, text, boolean)  TO service_role;
GRANT EXECUTE ON FUNCTION auth_code_check(text, text)                 TO service_role;
GRANT ALL ON platform_settings, auth_code_sends TO service_role;

NOTIFY pgrst, 'reload schema';

-- Checks:
-- SELECT key, value FROM platform_settings ORDER BY key;                       -- 5 rows
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'verification_codes' AND column_name = 'attempts';       -- 1 row
-- SELECT has_function_privilege('anon', 'auth_code_claim(text,text,text,boolean)', 'EXECUTE');  -- false
--
-- Change a limit later, e.g. the daily cap:
-- UPDATE platform_settings SET value = '60', updated_at = now() WHERE key = 'auth_codes_daily_cap';
