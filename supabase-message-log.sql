-- ============================================================================
-- MESSAGE LOG
-- ----------------------------------------------------------------------------
-- One row per WhatsApp / SMS message we hand to Twilio (and, later, per
-- inbound message if we choose to log those too).
--
-- The row is written at send time with status='queued'. Twilio then calls
-- POST /api/twilio/status-callback as the message moves through its
-- lifecycle (sent → delivered → read, or failed/undelivered) and that
-- webhook updates the same row by twilio_sid.
--
-- Writing here must NEVER block a send: lib/messageLog.ts swallows every
-- error. A missing row is an observability gap, not a user-facing failure.
--
-- Idempotent — safe to re-run.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS message_log (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Twilio's message SID (SMxxxxxxxx / MMxxxxxxxx). Nullable because a send
  -- that fails before Twilio accepts it has no SID, and UNIQUE so the status
  -- callback can safely upsert-by-SID without creating duplicates.
  twilio_sid        TEXT UNIQUE,

  direction         TEXT NOT NULL DEFAULT 'outbound'
                      CHECK (direction IN ('outbound', 'inbound')),
  channel           TEXT NOT NULL
                      CHECK (channel IN ('whatsapp', 'sms')),

  from_number       TEXT,
  to_number         TEXT,
  body              TEXT,                 -- truncated to 500 chars by the writer

  status            TEXT NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('queued', 'sent', 'delivered', 'read',
                                        'failed', 'undelivered')),
  status_updated_at TIMESTAMPTZ,          -- set by the Twilio status callback

  error_code        TEXT,                 -- Twilio error code, e.g. '63016'
  error_message     TEXT,                 -- human-readable description

  -- What triggered the message: 'verification_code', 'order_notification',
  -- 'order_status_update', 'payment_confirmation', 'event_reservation',
  -- 'event_update', 'broadcast', 'direct_message', 'subscription_alert',
  -- 'rating_prompt', 'bot_reply', … Free text on purpose — a new notification
  -- type must not require a migration.
  context           TEXT,
  related_id        UUID,                 -- order_id / event_id / reservation_id / …
  customer_id       UUID REFERENCES customers(id) ON DELETE SET NULL,

  cost              NUMERIC(10, 5),       -- from Twilio's Price field (negative)

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Columns are added defensively so re-running against a partially-created
-- table (e.g. an earlier draft of this migration) converges.
ALTER TABLE message_log ADD COLUMN IF NOT EXISTS twilio_sid        TEXT;
ALTER TABLE message_log ADD COLUMN IF NOT EXISTS direction         TEXT NOT NULL DEFAULT 'outbound';
ALTER TABLE message_log ADD COLUMN IF NOT EXISTS channel           TEXT;
ALTER TABLE message_log ADD COLUMN IF NOT EXISTS from_number       TEXT;
ALTER TABLE message_log ADD COLUMN IF NOT EXISTS to_number         TEXT;
ALTER TABLE message_log ADD COLUMN IF NOT EXISTS body              TEXT;
ALTER TABLE message_log ADD COLUMN IF NOT EXISTS status            TEXT NOT NULL DEFAULT 'queued';
ALTER TABLE message_log ADD COLUMN IF NOT EXISTS status_updated_at TIMESTAMPTZ;
ALTER TABLE message_log ADD COLUMN IF NOT EXISTS error_code        TEXT;
ALTER TABLE message_log ADD COLUMN IF NOT EXISTS error_message     TEXT;
ALTER TABLE message_log ADD COLUMN IF NOT EXISTS context           TEXT;
ALTER TABLE message_log ADD COLUMN IF NOT EXISTS related_id        UUID;
ALTER TABLE message_log ADD COLUMN IF NOT EXISTS customer_id       UUID;
ALTER TABLE message_log ADD COLUMN IF NOT EXISTS cost              NUMERIC(10, 5);
ALTER TABLE message_log ADD COLUMN IF NOT EXISTS created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Unique SID — required for the status callback's update-by-SID path.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public' AND indexname = 'message_log_twilio_sid_key'
  ) THEN
    CREATE UNIQUE INDEX message_log_twilio_sid_key
      ON message_log(twilio_sid) WHERE twilio_sid IS NOT NULL;
  END IF;
END $$;

-- ── Indexes ────────────────────────────────────────────────────────────────
-- The admin log is always ordered newest-first, so created_at is DESC.
-- The three filter columns (status / context / channel) are each low
-- cardinality but combine with the created_at sort in the dashboard.
CREATE INDEX IF NOT EXISTS message_log_to_number_idx   ON message_log(to_number);
CREATE INDEX IF NOT EXISTS message_log_customer_id_idx ON message_log(customer_id);
CREATE INDEX IF NOT EXISTS message_log_status_idx      ON message_log(status);
CREATE INDEX IF NOT EXISTS message_log_context_idx     ON message_log(context);
CREATE INDEX IF NOT EXISTS message_log_created_at_idx  ON message_log(created_at DESC);
CREATE INDEX IF NOT EXISTS message_log_related_id_idx  ON message_log(related_id);

-- ── RLS ────────────────────────────────────────────────────────────────────
-- Message bodies contain verification codes, names and order details. The
-- table is service-role only; the admin dashboard reads it through
-- /api/admin/messages, which checks the session role first.
ALTER TABLE message_log ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename  = 'message_log'
       AND policyname = 'message_log_service_only'
  ) THEN
    CREATE POLICY message_log_service_only ON message_log
      FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;

COMMIT;

-- ── Verify ─────────────────────────────────────────────────────────────────
-- SELECT column_name, data_type FROM information_schema.columns
--  WHERE table_name = 'message_log' ORDER BY ordinal_position;
