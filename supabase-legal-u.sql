-- U2 — data deletion requests (web form or WhatsApp "SUPPRIMER").
-- Run once in the Supabase SQL Editor; safe to re-run. Server-only (RLS on,
-- no policy). Legal / contact values live in platform_settings
-- (key 'legal_contact', written from Admin → Plateforme): no SQL needed.
CREATE TABLE IF NOT EXISTS data_deletion_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone        text NOT NULL,
  reason       text,
  customer_id  uuid NULL REFERENCES customers(id) ON DELETE SET NULL,
  via          text NOT NULL DEFAULT 'web' CHECK (via IN ('web', 'whatsapp')),
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'rejected')),
  handled_by   uuid NULL,
  handled_at   timestamptz,
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS data_deletion_requests_status_idx ON data_deletion_requests (status, created_at DESC);
ALTER TABLE data_deletion_requests ENABLE ROW LEVEL SECURITY;

-- Check (should return the table name)
-- SELECT to_regclass('public.data_deletion_requests');
