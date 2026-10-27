-- D3: SMS when WhatsApp can't deliver (63016 outside the 24 h window,
-- 63015 not joined to the Twilio sandbox). Safe to re-run.
--
-- message_log.fallback_sent_at — set when the SMS fallback for this WhatsApp
-- message was sent, so Twilio's repeated delivery reports never send a
-- second SMS.
ALTER TABLE message_log ADD COLUMN IF NOT EXISTS fallback_sent_at timestamptz;

NOTIFY pgrst, 'reload schema';

-- Check (expect 1 row):
-- SELECT column_name FROM information_schema.columns
--  WHERE table_name = 'message_log' AND column_name = 'fallback_sent_at';


-- ── D1 follow-up: mask login codes ALREADY in the log ───────────────────────
-- New rows are masked by the app since D1; this cleans the old ones. Run
-- once. Every 4-to-8-digit number in a login-code message becomes ••••••.
--
-- UPDATE message_log
--    SET body = regexp_replace(body, '\d{4,8}', '••••••', 'g')
--  WHERE context = 'verification_code' AND body ~ '\d{4,8}';
--
-- Check (expect 0):
-- SELECT count(*) FROM message_log WHERE context = 'verification_code' AND body ~ '\d{4,8}';
