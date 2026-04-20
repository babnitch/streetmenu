-- ============================================================================
-- TEAM INVITATIONS
-- ----------------------------------------------------------------------------
-- WhatsApp-based team invitations: an owner can invite a phone number (even
-- one that isn't yet a customer) to join their restaurant as manager/staff.
-- The invitee replies "accepter" / "refuser" to accept or decline. Accepting
-- an invitation registers the customer (if needed) and inserts the matching
-- row into restaurant_team.
--
-- Expiry is lazy: rows with status='pending' AND expires_at < now() are
-- treated as expired at read time. A future sweep job can flip the status
-- column, but it isn't required for correctness.
--
-- Run in Supabase SQL Editor:
--   https://supabase.com/dashboard/project/xylfxtdgpptvieobvlfj/sql
--
-- Idempotent — safe to re-run.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS team_invitations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  phone         TEXT NOT NULL,                    -- normalised E.164 (e.g. +237670000000)
  role          TEXT NOT NULL CHECK (role IN ('manager', 'staff')),
  invited_by    UUID REFERENCES customers(id) ON DELETE SET NULL,
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'accepted', 'expired', 'declined', 'cancelled')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
  accepted_at   TIMESTAMPTZ
);

-- Look-up indexes. The phone index drives the "has pending invitation?" probe
-- that fires on every WhatsApp accept/decline reply — keep it selective.
CREATE INDEX IF NOT EXISTS idx_team_invitations_phone         ON team_invitations(phone);
CREATE INDEX IF NOT EXISTS idx_team_invitations_restaurant_id ON team_invitations(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_team_invitations_status        ON team_invitations(status);
CREATE INDEX IF NOT EXISTS idx_team_invitations_invited_by    ON team_invitations(invited_by);

-- Partial unique index: only one pending invitation per (restaurant, phone).
-- Accepted / declined / cancelled / expired rows stay around for audit.
CREATE UNIQUE INDEX IF NOT EXISTS uq_team_invitations_pending
  ON team_invitations (restaurant_id, phone)
  WHERE status = 'pending';

ALTER TABLE team_invitations ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'team_invitations' AND policyname = 'team_invitations_service_only'
  ) THEN
    CREATE POLICY team_invitations_service_only ON team_invitations
      FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;

COMMIT;
