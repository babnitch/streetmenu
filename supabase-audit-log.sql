-- ============================================================================
-- AUDIT LOG
-- ----------------------------------------------------------------------------
-- Permanent record of sensitive actions. Survives anonymisation/cleanup so
-- a phone number can never be silently reused without trace.
--
-- Idempotent — safe to re-run.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS audit_log (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action            TEXT NOT NULL,        -- 'number_released', 'account_deleted', 'account_suspended', 'restaurant_deleted', ...
  target_type       TEXT NOT NULL,        -- 'customer' | 'restaurant' | 'admin_user' | ...
  target_id         UUID NOT NULL,
  performed_by      UUID,                 -- admin_users.id or customers.id, nullable for 'system'
  performed_by_type TEXT,                 -- 'super_admin' | 'admin' | 'moderator' | 'vendor' | 'customer' | 'system'
  previous_data     JSONB,                -- snapshot BEFORE the action (esp. before anonymisation)
  metadata          JSONB,                -- any extra context
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_target        ON audit_log(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_action        ON audit_log(action);
CREATE INDEX IF NOT EXISTS idx_audit_log_performed_by  ON audit_log(performed_by);
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at    ON audit_log(created_at DESC);

-- Service-role only: the table contains PII snapshots and must never be
-- exposed to the anon client.
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'audit_log' AND policyname = 'audit_log_service_only'
  ) THEN
    CREATE POLICY audit_log_service_only ON audit_log
      FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;

COMMIT;
