-- =============================================================================
-- Reviews, likes, comments, reports
-- Run this in Supabase SQL Editor
-- =============================================================================
-- Lays the full schema for the Batch F system in one go. Batch F (this commit)
-- only exercises customers.nickname + restaurant_ratings. event_likes,
-- event_comments, and reports tables ship now to keep the migration history
-- tidy — they're inert until later batches wire UI to them.
-- Idempotent — safe to re-run.
-- =============================================================================

-- 1. customers: nickname for comment authorship -------------------------------
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS nickname            TEXT,
  ADD COLUMN IF NOT EXISTS nickname_updated_at TIMESTAMPTZ;

-- 2. restaurant_ratings -------------------------------------------------------
-- One rating per (restaurant, customer, order). Re-rating the same order
-- updates the row; the UNIQUE constraint enforces that downstream.
CREATE TABLE IF NOT EXISTS restaurant_ratings (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID        NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  customer_id   UUID        NOT NULL REFERENCES customers(id)   ON DELETE CASCADE,
  order_id      UUID        NOT NULL REFERENCES orders(id)      ON DELETE CASCADE,
  rating        INTEGER     NOT NULL CHECK (rating >= 1 AND rating <= 5),
  tags          TEXT[],
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (restaurant_id, customer_id, order_id)
);
ALTER TABLE restaurant_ratings ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'restaurant_ratings' AND policyname = 'service_role_only'
  ) THEN CREATE POLICY "service_role_only" ON restaurant_ratings USING (false); END IF;
END $$;
CREATE INDEX IF NOT EXISTS restaurant_ratings_restaurant_idx ON restaurant_ratings(restaurant_id);
CREATE INDEX IF NOT EXISTS restaurant_ratings_customer_idx   ON restaurant_ratings(customer_id);
CREATE INDEX IF NOT EXISTS restaurant_ratings_order_idx      ON restaurant_ratings(order_id);

-- 3. event_likes (Batch G) ----------------------------------------------------
CREATE TABLE IF NOT EXISTS event_likes (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    UUID        NOT NULL REFERENCES events(id)    ON DELETE CASCADE,
  customer_id UUID        NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (event_id, customer_id)
);
ALTER TABLE event_likes ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'event_likes' AND policyname = 'service_role_only'
  ) THEN CREATE POLICY "service_role_only" ON event_likes USING (false); END IF;
END $$;
CREATE INDEX IF NOT EXISTS event_likes_event_idx    ON event_likes(event_id);
CREATE INDEX IF NOT EXISTS event_likes_customer_idx ON event_likes(customer_id);

-- 4. event_comments (Batch G) -------------------------------------------------
CREATE TABLE IF NOT EXISTS event_comments (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    UUID        NOT NULL REFERENCES events(id)    ON DELETE CASCADE,
  customer_id UUID        NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  comment     TEXT        NOT NULL CHECK (char_length(comment) <= 500),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_deleted  BOOLEAN     NOT NULL DEFAULT FALSE,
  deleted_by  UUID        REFERENCES admin_users(id) ON DELETE SET NULL,
  deleted_at  TIMESTAMPTZ
);
ALTER TABLE event_comments ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'event_comments' AND policyname = 'service_role_only'
  ) THEN CREATE POLICY "service_role_only" ON event_comments USING (false); END IF;
END $$;
CREATE INDEX IF NOT EXISTS event_comments_event_idx    ON event_comments(event_id);
CREATE INDEX IF NOT EXISTS event_comments_customer_idx ON event_comments(customer_id);
CREATE INDEX IF NOT EXISTS event_comments_active_idx   ON event_comments(event_id, is_deleted);

-- 5. reports (Batch H) --------------------------------------------------------
CREATE TABLE IF NOT EXISTS reports (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id  UUID        NOT NULL REFERENCES customers(id) ON DELETE SET NULL,
  target_type  TEXT        NOT NULL CHECK (target_type IN ('restaurant', 'event', 'comment')),
  target_id    UUID        NOT NULL,
  reason       TEXT        NOT NULL CHECK (reason IN ('inappropriate', 'spam', 'fake', 'offensive', 'fraud', 'other')),
  description  TEXT,
  status       TEXT        NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'reviewed', 'action_taken', 'dismissed')),
  reviewed_by  UUID        REFERENCES admin_users(id) ON DELETE SET NULL,
  reviewed_at  TIMESTAMPTZ,
  admin_notes  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE reports ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'reports' AND policyname = 'service_role_only'
  ) THEN CREATE POLICY "service_role_only" ON reports USING (false); END IF;
END $$;
CREATE INDEX IF NOT EXISTS reports_status_idx    ON reports(status);
CREATE INDEX IF NOT EXISTS reports_target_idx    ON reports(target_type, target_id);
CREATE INDEX IF NOT EXISTS reports_reporter_idx  ON reports(reporter_id);
