-- ============================================================================
-- MESSAGE RETRY QUEUE
-- ----------------------------------------------------------------------------
-- WhatsApp notifications that Twilio refused for a TEMPORARY reason — above
-- all 63038 (trial account: 50 messages per rolling 24h), and rate limits
-- (20429, 63018, 14107, HTTP 429) — are queued here and re-sent later by
-- lib/messageRetry.ts, which runs from the existing pawapay-reconcile cron
-- (POST /api/payments/reconcile, every 10 min).
--
-- Only customer/vendor NOTIFICATIONS are queued (payment confirmations, order
-- and reservation updates). Bot replies, verification codes and broadcasts
-- are not: re-sent hours later they would be stale or confusing.
--
-- A row is written either at send time (Twilio rejected the API call) or by
-- the Twilio status callback (accepted, then failed). last_log_id points at
-- the message_log row of the latest attempt, so a retry that is accepted and
-- then fails again updates THIS row instead of starting a fresh one.
--
-- Service-role only (RLS on, no policies). Idempotent — safe to re-run.
-- Run BEFORE deploying the code that writes it; until then enqueueing just
-- logs an error and the original failure stays visible in message_log.
-- ============================================================================

CREATE TABLE IF NOT EXISTS message_retry_queue (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  last_log_id      UUID UNIQUE REFERENCES message_log(id) ON DELETE SET NULL,
  channel          TEXT NOT NULL DEFAULT 'whatsapp' CHECK (channel IN ('whatsapp')),
  to_number        TEXT NOT NULL,
  body             TEXT NOT NULL,
  context          TEXT,
  related_id       UUID,
  customer_id      UUID REFERENCES customers(id) ON DELETE SET NULL,
  status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'sending', 'sent', 'gave_up')),
  attempts         INTEGER NOT NULL DEFAULT 1,   -- failed or made sends so far
  next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error_code  TEXT,
  last_error       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS message_retry_queue_due_idx
  ON message_retry_queue (next_attempt_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS message_retry_queue_related_idx
  ON message_retry_queue (related_id);
CREATE INDEX IF NOT EXISTS message_retry_queue_created_idx
  ON message_retry_queue (created_at);

ALTER TABLE message_retry_queue ENABLE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';

-- Verify:
--   SELECT count(*) FROM message_retry_queue;            -- table exists
--   SELECT relrowsecurity FROM pg_class WHERE relname = 'message_retry_queue';  -- true
--
-- What is queued / given up:
--   SELECT status, count(*) FROM message_retry_queue GROUP BY status;
--   SELECT to_number, context, attempts, next_attempt_at, last_error_code
--     FROM message_retry_queue WHERE status = 'pending' ORDER BY next_attempt_at;
