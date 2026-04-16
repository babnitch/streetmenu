-- Vouchers & customer accounts migration
-- Run in Supabase SQL Editor: https://supabase.com/dashboard/project/xylfxtdgpptvieobvlfj/sql

-- ── 1. Vouchers table ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vouchers (
  id             UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  code           TEXT        NOT NULL UNIQUE,
  discount_type  TEXT        NOT NULL CHECK (discount_type IN ('percent', 'fixed')),
  discount_value NUMERIC(10,2) NOT NULL,
  min_order      NUMERIC(10,2) DEFAULT 0,
  max_uses       INTEGER     DEFAULT NULL,   -- NULL = unlimited
  uses_count     INTEGER     DEFAULT 0,
  expires_at     TIMESTAMPTZ DEFAULT NULL,
  is_active      BOOLEAN     DEFAULT true,
  city           TEXT        DEFAULT NULL,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE vouchers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "vouchers_select" ON vouchers FOR SELECT USING (true);
CREATE POLICY "vouchers_insert" ON vouchers FOR INSERT WITH CHECK (true);
CREATE POLICY "vouchers_update" ON vouchers FOR UPDATE USING (true);
CREATE POLICY "vouchers_delete" ON vouchers FOR DELETE USING (true);

-- ── 2. Customer vouchers junction ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS customer_vouchers (
  id          UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  customer_id UUID        NOT NULL,
  voucher_id  UUID        NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
  claimed_at  TIMESTAMPTZ DEFAULT NOW(),
  used_at     TIMESTAMPTZ DEFAULT NULL
);

ALTER TABLE customer_vouchers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "cv_select" ON customer_vouchers FOR SELECT USING (true);
CREATE POLICY "cv_insert" ON customer_vouchers FOR INSERT WITH CHECK (true);
CREATE POLICY "cv_update" ON customer_vouchers FOR UPDATE USING (true);
CREATE POLICY "cv_delete" ON customer_vouchers FOR DELETE USING (true);

-- ── 3. Extend orders table ────────────────────────────────────────────────
ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_id      UUID;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS voucher_code     TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_amount  NUMERIC(10,2) DEFAULT 0;

-- ── 4. Seed welcome voucher ───────────────────────────────────────────────
INSERT INTO vouchers (code, discount_type, discount_value, min_order, max_uses, is_active)
VALUES ('BIENVENUE10', 'percent', 10, 500, NULL, true)
ON CONFLICT (code) DO NOTHING;
