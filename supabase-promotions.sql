-- =============================================================================
-- Paid promotions (Instagram-style native ads)
-- Run this in Supabase SQL Editor
-- =============================================================================
-- Lets restaurant owners and verified event publishers pay to feature
-- their listing in three placements:
--
--   top_list   — pinned to the top of the home / events list
--   feed_card  — injected every Nth position inside the regular feed
--   banner     — small banner between sections on the restaurant detail
--
-- Billing model: per-day, full amount upfront. Impressions + clicks
-- are tracked for analytics but don't affect the price.
--
-- Lifecycle:
--   draft → pending_review → active → completed
--                          ↘ rejected
--                          ↘ paused
--
-- The pending_review gate is so an admin can vet ad copy before it
-- goes live in the public feed.
--
-- Idempotent — safe to re-run.
-- =============================================================================

CREATE TABLE IF NOT EXISTS promotions (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  promoter_id     UUID        NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  target_type     TEXT        NOT NULL CHECK (target_type IN ('restaurant', 'event')),
  target_id       UUID        NOT NULL,
  placement       TEXT        NOT NULL CHECK (placement IN ('top_list', 'feed_card', 'banner')),
  city            TEXT        NOT NULL,
  start_date      TIMESTAMPTZ NOT NULL,
  end_date        TIMESTAMPTZ NOT NULL,
  daily_budget    INTEGER,
  total_budget    INTEGER     NOT NULL,
  amount_spent    INTEGER     NOT NULL DEFAULT 0,
  impressions     INTEGER     NOT NULL DEFAULT 0,
  clicks          INTEGER     NOT NULL DEFAULT 0,
  payment_status  TEXT        NOT NULL DEFAULT 'pending'
    CHECK (payment_status IN ('pending', 'paid', 'failed')),
  payment_id      TEXT,
  status          TEXT        NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'pending_review', 'active', 'paused', 'completed', 'rejected')),
  reviewed_by     UUID        REFERENCES admin_users(id) ON DELETE SET NULL,
  rejection_reason TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE promotions ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename  = 'promotions'
       AND policyname = 'service_role_only'
  ) THEN
    CREATE POLICY "service_role_only" ON promotions USING (false);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS promotions_promoter_id_idx  ON promotions(promoter_id);
CREATE INDEX IF NOT EXISTS promotions_target_idx       ON promotions(target_type, target_id);
CREATE INDEX IF NOT EXISTS promotions_status_idx       ON promotions(status);
CREATE INDEX IF NOT EXISTS promotions_city_idx         ON promotions(city);
CREATE INDEX IF NOT EXISTS promotions_dates_idx        ON promotions(start_date, end_date);
CREATE INDEX IF NOT EXISTS promotions_payment_id_idx   ON promotions(payment_id);
-- Composite index for the hot path: "active promotions for city X of type Y today"
CREATE INDEX IF NOT EXISTS promotions_active_lookup_idx
  ON promotions(city, target_type, status)
  WHERE status = 'active';

-- =============================================================================
-- Pricing config (admin-editable single-row-per-placement)
-- =============================================================================
CREATE TABLE IF NOT EXISTS promotion_pricing (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  placement         TEXT        NOT NULL CHECK (placement IN ('top_list', 'feed_card', 'banner')),
  price_per_day     INTEGER     NOT NULL,
  min_duration_days INTEGER     NOT NULL DEFAULT 1,
  max_duration_days INTEGER     NOT NULL DEFAULT 30,
  is_active         BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE promotion_pricing ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename  = 'promotion_pricing'
       AND policyname = 'service_role_only'
  ) THEN
    CREATE POLICY "service_role_only" ON promotion_pricing USING (false);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS promotion_pricing_active_idx
  ON promotion_pricing(placement)
  WHERE is_active = TRUE;

-- Seed one active row per placement. Skipped per-placement if a row
-- already exists for it.
INSERT INTO promotion_pricing (placement, price_per_day, min_duration_days, max_duration_days)
SELECT 'top_list', 2000, 1, 30
WHERE NOT EXISTS (SELECT 1 FROM promotion_pricing WHERE placement = 'top_list');

INSERT INTO promotion_pricing (placement, price_per_day, min_duration_days, max_duration_days)
SELECT 'feed_card', 1000, 1, 30
WHERE NOT EXISTS (SELECT 1 FROM promotion_pricing WHERE placement = 'feed_card');

INSERT INTO promotion_pricing (placement, price_per_day, min_duration_days, max_duration_days)
SELECT 'banner', 500, 1, 30
WHERE NOT EXISTS (SELECT 1 FROM promotion_pricing WHERE placement = 'banner');
