-- WhatsApp onboarding & custom auth migration
-- Run in Supabase SQL Editor:
-- https://supabase.com/dashboard/project/xylfxtdgpptvieobvlfj/sql

-- ── 1. customers table (unified identity, phone = primary key) ────────────────
CREATE TABLE IF NOT EXISTS customers (
  id         UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  phone      TEXT        NOT NULL UNIQUE,
  name       TEXT        NOT NULL,
  city       TEXT        NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "customers_select" ON customers FOR SELECT USING (true);
CREATE POLICY "customers_insert" ON customers FOR INSERT WITH CHECK (true);
CREATE POLICY "customers_update" ON customers FOR UPDATE USING (true);

-- ── 2. verification_codes (WhatsApp OTP, 4-digit, 5-min TTL) ─────────────────
CREATE TABLE IF NOT EXISTS verification_codes (
  id         UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  phone      TEXT        NOT NULL,
  code       TEXT        NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used       BOOLEAN     DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE verification_codes ENABLE ROW LEVEL SECURITY;
-- Only accessible via service-role key in API routes — no public policies needed.

-- ── 3. signup_sessions (WhatsApp multi-step onboarding, 1-hr TTL) ─────────────
CREATE TABLE IF NOT EXISTS signup_sessions (
  phone      TEXT        PRIMARY KEY,           -- one session per phone
  user_type  TEXT        NOT NULL CHECK (user_type IN ('customer', 'vendor')),
  step       INTEGER     NOT NULL DEFAULT 1,
  data       JSONB       NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

ALTER TABLE signup_sessions ENABLE ROW LEVEL SECURITY;
-- Only accessible via service-role key in API routes — no public policies needed.

-- ── 4. Link restaurants → customers ──────────────────────────────────────────
ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES customers(id);

-- ── 5. Cleanup index on verification_codes ───────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_verification_codes_phone ON verification_codes (phone);
