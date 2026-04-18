-- ============================================================================
-- STREETMENU DATABASE OPTIMIZATION MIGRATION
-- ----------------------------------------------------------------------------
-- Safe, idempotent migration. Run once in the Supabase SQL editor.
--
-- Goals:
--   1. Backfill missing relationships without losing any data
--   2. Add foreign keys, indexes, and check constraints the schema was missing
--   3. Enforce integrity via triggers (cascade suspend, auto-link, updated_at)
--   4. Introduce a relational `order_items` table alongside existing JSONB
--
-- This script never DROPs tables and never DELETEs rows. Re-running it is safe.
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. NEW COLUMNS
-- ============================================================================

-- events.submitted_by — who submitted the event (nullable for historical rows)
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS submitted_by UUID REFERENCES customers(id) ON DELETE SET NULL;

-- events.restaurant_id — optional: event hosted by a restaurant
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS restaurant_id UUID REFERENCES restaurants(id) ON DELETE SET NULL;

-- vouchers.restaurant_id — optional: restaurant-specific vouchers (NULL = platform-wide)
ALTER TABLE vouchers
  ADD COLUMN IF NOT EXISTS restaurant_id UUID REFERENCES restaurants(id) ON DELETE CASCADE;

-- customer_vouchers.order_id — which order consumed the voucher
ALTER TABLE customer_vouchers
  ADD COLUMN IF NOT EXISTS order_id UUID REFERENCES orders(id) ON DELETE SET NULL;

-- updated_at on all mutable tables
ALTER TABLE customers         ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE restaurants       ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE menu_items        ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE orders            ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE vouchers          ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE customer_vouchers ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE events            ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE admin_users       ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE restaurant_team   ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- ============================================================================
-- 2. NEW TABLE: order_items (relational alongside orders.items JSONB)
-- ============================================================================
-- orders.items JSONB stays as source of truth for legacy reads.
-- order_items is the go-forward relational home with FK to menu_items.

CREATE TABLE IF NOT EXISTS order_items (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id       UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  menu_item_id   UUID REFERENCES menu_items(id) ON DELETE SET NULL,
  name           TEXT NOT NULL,        -- snapshot at order time
  price          NUMERIC(10,2) NOT NULL CHECK (price >= 0),
  quantity       INTEGER NOT NULL CHECK (quantity > 0),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_order_items_order_id     ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_menu_item_id ON order_items(menu_item_id);

-- ============================================================================
-- 3. BACKFILLS (idempotent, safe to re-run)
-- ============================================================================

-- 3a. Link orphaned restaurants to matching customer by phone; create
--     a customer account from the restaurant's own details if no match.
DO $$
DECLARE
  r          RECORD;
  cust_id    UUID;
BEGIN
  FOR r IN
    SELECT id, name, whatsapp, city FROM restaurants WHERE customer_id IS NULL
  LOOP
    SELECT id INTO cust_id FROM customers WHERE phone = r.whatsapp LIMIT 1;
    IF cust_id IS NULL THEN
      INSERT INTO customers (name, phone, city, status)
      VALUES (r.name, r.whatsapp, COALESCE(r.city, 'Yaoundé'), 'active')
      RETURNING id INTO cust_id;
    END IF;
    UPDATE restaurants SET customer_id = cust_id WHERE id = r.id;
    INSERT INTO restaurant_team (restaurant_id, customer_id, role, status, added_by)
    VALUES (r.id, cust_id, 'owner', 'active', NULL)
    ON CONFLICT (restaurant_id, customer_id) DO NOTHING;
  END LOOP;
END $$;

-- 3b. Every restaurant must have an owner row in restaurant_team.
INSERT INTO restaurant_team (restaurant_id, customer_id, role, status)
SELECT r.id, r.customer_id, 'owner', 'active'
FROM restaurants r
WHERE r.customer_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM restaurant_team t
    WHERE t.restaurant_id = r.id AND t.customer_id = r.customer_id
  )
ON CONFLICT (restaurant_id, customer_id) DO NOTHING;

-- 3c. Backfill orders.customer_id by matching customer_phone.
UPDATE orders o
SET customer_id = c.id
FROM customers c
WHERE o.customer_id IS NULL
  AND o.customer_phone IS NOT NULL
  AND c.phone = o.customer_phone;

-- 3d. Backfill events.submitted_by by matching events.whatsapp against a customer.
UPDATE events e
SET submitted_by = c.id
FROM customers c
WHERE e.submitted_by IS NULL
  AND e.whatsapp IS NOT NULL
  AND c.phone = e.whatsapp;

-- 3e. Backfill order_items from orders.items JSONB. Matches menu items
--     by (restaurant_id, name) using case-insensitive exact compare.
--     If a name matches no menu item, menu_item_id stays NULL.
DO $$
DECLARE
  o       RECORD;
  item    JSONB;
  mi_id   UUID;
BEGIN
  FOR o IN
    SELECT id, restaurant_id, items FROM orders
    WHERE items IS NOT NULL
      AND jsonb_typeof(items) = 'array'
      AND NOT EXISTS (SELECT 1 FROM order_items WHERE order_id = orders.id)
  LOOP
    FOR item IN SELECT jsonb_array_elements(o.items)
    LOOP
      SELECT id INTO mi_id
      FROM menu_items
      WHERE restaurant_id = o.restaurant_id
        AND LOWER(name) = LOWER(item->>'name')
      LIMIT 1;

      INSERT INTO order_items (order_id, menu_item_id, name, price, quantity)
      VALUES (
        o.id,
        mi_id,
        COALESCE(item->>'name', ''),
        COALESCE((item->>'price')::NUMERIC, 0),
        COALESCE((item->>'quantity')::INTEGER, 1)
      );
    END LOOP;
  END LOOP;
END $$;

-- ============================================================================
-- 4. CONSTRAINTS (idempotent — only add if missing)
-- ============================================================================

-- 4a. restaurants.customer_id → NOT NULL (only if backfill left no orphans)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM restaurants WHERE customer_id IS NULL) THEN
    BEGIN
      ALTER TABLE restaurants ALTER COLUMN customer_id SET NOT NULL;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'restaurants.customer_id NOT NULL skipped: %', SQLERRM;
    END;
  ELSE
    RAISE NOTICE 'restaurants.customer_id: % orphaned rows remain; NOT NULL skipped',
      (SELECT COUNT(*) FROM restaurants WHERE customer_id IS NULL);
  END IF;
END $$;

-- 4b. menu_items.price >= 0
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'menu_items_price_nonneg'
  ) THEN
    ALTER TABLE menu_items ADD CONSTRAINT menu_items_price_nonneg CHECK (price >= 0);
  END IF;
END $$;

-- 4c. orders.total_price >= 0
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'orders_total_price_nonneg'
  ) THEN
    ALTER TABLE orders ADD CONSTRAINT orders_total_price_nonneg CHECK (total_price >= 0);
  END IF;
END $$;

-- 4d. customers.phone UNIQUE + NOT NULL (already enforced in base schema;
--     re-check here as a safety net)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'customers_phone_key'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'customers'::regclass AND contype = 'u'
      AND conkey = (SELECT ARRAY[attnum] FROM pg_attribute
                    WHERE attrelid = 'customers'::regclass AND attname = 'phone')
  ) THEN
    BEGIN
      ALTER TABLE customers ADD CONSTRAINT customers_phone_unique UNIQUE (phone);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END IF;
END $$;

-- ============================================================================
-- 5. INDEXES — on every FK column and every column used in WHERE / ORDER BY
-- ============================================================================

-- restaurants
CREATE INDEX IF NOT EXISTS idx_restaurants_customer_id  ON restaurants(customer_id);
CREATE INDEX IF NOT EXISTS idx_restaurants_status       ON restaurants(status);
CREATE INDEX IF NOT EXISTS idx_restaurants_is_active    ON restaurants(is_active);
CREATE INDEX IF NOT EXISTS idx_restaurants_whatsapp     ON restaurants(whatsapp);
CREATE INDEX IF NOT EXISTS idx_restaurants_city         ON restaurants(city);
CREATE INDEX IF NOT EXISTS idx_restaurants_created_at   ON restaurants(created_at DESC);

-- customers
CREATE INDEX IF NOT EXISTS idx_customers_status         ON customers(status);
CREATE INDEX IF NOT EXISTS idx_customers_deleted_at     ON customers(deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_customers_created_at     ON customers(created_at DESC);

-- orders
CREATE INDEX IF NOT EXISTS idx_orders_restaurant_id     ON orders(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_orders_customer_id       ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_status            ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created_at        ON orders(created_at DESC);
-- Compound index used by the vendor dashboard "open orders for my restaurant" query
CREATE INDEX IF NOT EXISTS idx_orders_rest_status       ON orders(restaurant_id, status);

-- menu_items
CREATE INDEX IF NOT EXISTS idx_menu_items_restaurant_id ON menu_items(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_menu_items_is_available  ON menu_items(is_available);
CREATE INDEX IF NOT EXISTS idx_menu_items_rest_name     ON menu_items(restaurant_id, LOWER(name));

-- restaurant_team
CREATE INDEX IF NOT EXISTS idx_team_restaurant_id       ON restaurant_team(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_team_customer_id         ON restaurant_team(customer_id);
CREATE INDEX IF NOT EXISTS idx_team_status              ON restaurant_team(status);

-- vouchers
CREATE INDEX IF NOT EXISTS idx_vouchers_code            ON vouchers(code);
CREATE INDEX IF NOT EXISTS idx_vouchers_is_active       ON vouchers(is_active);
CREATE INDEX IF NOT EXISTS idx_vouchers_restaurant_id   ON vouchers(restaurant_id);

-- customer_vouchers
CREATE INDEX IF NOT EXISTS idx_cv_customer_id           ON customer_vouchers(customer_id);
CREATE INDEX IF NOT EXISTS idx_cv_voucher_id            ON customer_vouchers(voucher_id);
CREATE INDEX IF NOT EXISTS idx_cv_order_id              ON customer_vouchers(order_id);
CREATE INDEX IF NOT EXISTS idx_cv_used_at               ON customer_vouchers(used_at);

-- events
CREATE INDEX IF NOT EXISTS idx_events_city              ON events(city);
CREATE INDEX IF NOT EXISTS idx_events_date              ON events(date);
CREATE INDEX IF NOT EXISTS idx_events_is_active         ON events(is_active);
CREATE INDEX IF NOT EXISTS idx_events_submitted_by      ON events(submitted_by);
CREATE INDEX IF NOT EXISTS idx_events_restaurant_id     ON events(restaurant_id);

-- admin_users
CREATE INDEX IF NOT EXISTS idx_admin_users_role         ON admin_users(role);
CREATE INDEX IF NOT EXISTS idx_admin_users_status       ON admin_users(status);

-- verification_codes
CREATE INDEX IF NOT EXISTS idx_vcodes_phone             ON verification_codes(phone);
CREATE INDEX IF NOT EXISTS idx_vcodes_expires_at        ON verification_codes(expires_at);

-- signup_sessions
CREATE INDEX IF NOT EXISTS idx_sessions_user_type       ON signup_sessions(user_type);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at      ON signup_sessions(expires_at);

-- ============================================================================
-- 6. TRIGGERS
-- ============================================================================

-- 6a. Auto-update updated_at on every UPDATE
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY[
      'customers','restaurants','menu_items','orders','vouchers',
      'customer_vouchers','events','admin_users','restaurant_team'
    ])
  LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS trg_%I_updated_at ON %I; '
      'CREATE TRIGGER trg_%I_updated_at BEFORE UPDATE ON %I '
      'FOR EACH ROW EXECUTE FUNCTION set_updated_at();',
      t, t, t, t
    );
  END LOOP;
END $$;

-- 6b. When a new restaurant is inserted WITH a customer_id, auto-create
--     the owner row in restaurant_team.
CREATE OR REPLACE FUNCTION ensure_restaurant_owner() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.customer_id IS NOT NULL THEN
    INSERT INTO restaurant_team (restaurant_id, customer_id, role, status)
    VALUES (NEW.id, NEW.customer_id, 'owner', 'active')
    ON CONFLICT (restaurant_id, customer_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_restaurants_ensure_owner ON restaurants;
CREATE TRIGGER trg_restaurants_ensure_owner
  AFTER INSERT ON restaurants
  FOR EACH ROW EXECUTE FUNCTION ensure_restaurant_owner();

-- 6c. When a customer is soft-deleted (status → 'deleted'), auto-suspend
--     their active/pending restaurants with suspended_by='system'.
CREATE OR REPLACE FUNCTION cascade_customer_delete() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'deleted' AND (OLD.status IS DISTINCT FROM 'deleted') THEN
    UPDATE restaurants
    SET status             = 'suspended',
        suspended_at       = NOW(),
        suspended_by       = 'system',
        suspension_reason  = 'Account deleted'
    WHERE customer_id = NEW.id
      AND status IN ('active', 'pending');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_customers_cascade_delete ON customers;
CREATE TRIGGER trg_customers_cascade_delete
  AFTER UPDATE OF status ON customers
  FOR EACH ROW EXECUTE FUNCTION cascade_customer_delete();

-- 6d. When a customer is reactivated (status: deleted/suspended → active),
--     auto-reactivate restaurants that were suspended_by='system'.
CREATE OR REPLACE FUNCTION cascade_customer_reactivate() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'active' AND OLD.status IN ('suspended', 'deleted') THEN
    UPDATE restaurants
    SET status             = 'active',
        suspended_at       = NULL,
        suspended_by       = NULL,
        suspension_reason  = NULL
    WHERE customer_id = NEW.id
      AND suspended_by = 'system';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_customers_cascade_reactivate ON customers;
CREATE TRIGGER trg_customers_cascade_reactivate
  AFTER UPDATE OF status ON customers
  FOR EACH ROW EXECUTE FUNCTION cascade_customer_reactivate();

-- 6e. When a new customer is created via WhatsApp, auto-link any restaurants
--     whose whatsapp number matches the customer's phone and have no customer_id.
CREATE OR REPLACE FUNCTION auto_link_orphaned_on_customer_insert() RETURNS TRIGGER AS $$
BEGIN
  UPDATE restaurants
  SET customer_id = NEW.id
  WHERE customer_id IS NULL
    AND whatsapp = NEW.phone;

  INSERT INTO restaurant_team (restaurant_id, customer_id, role, status)
  SELECT id, NEW.id, 'owner', 'active'
  FROM restaurants
  WHERE customer_id = NEW.id
    AND NOT EXISTS (
      SELECT 1 FROM restaurant_team t
      WHERE t.restaurant_id = restaurants.id AND t.customer_id = NEW.id
    );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_customers_autolink ON customers;
CREATE TRIGGER trg_customers_autolink
  AFTER INSERT ON customers
  FOR EACH ROW EXECUTE FUNCTION auto_link_orphaned_on_customer_insert();

-- ============================================================================
-- 7. RPC FUNCTIONS (transactional multi-step writes)
-- ============================================================================

-- 7a. Atomic account deletion (triggers cascade automatically; RPC kept
--     for API callers that want a single result).
CREATE OR REPLACE FUNCTION delete_customer_cascade(p_customer_id UUID)
RETURNS TABLE(restaurants_suspended INTEGER) AS $$
DECLARE
  n INTEGER;
BEGIN
  UPDATE customers
  SET status = 'deleted', deleted_at = NOW()
  WHERE id = p_customer_id AND status != 'deleted';
  -- cascade_customer_delete trigger handles the restaurants side

  SELECT COUNT(*) INTO n
  FROM restaurants
  WHERE customer_id = p_customer_id
    AND suspended_by = 'system'
    AND suspended_at IS NOT NULL;
  restaurants_suspended := n;
  RETURN NEXT;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 7b. Atomic account reactivation
CREATE OR REPLACE FUNCTION reactivate_customer_cascade(p_customer_id UUID)
RETURNS TABLE(restaurants_reactivated INTEGER) AS $$
DECLARE
  n INTEGER;
BEGIN
  UPDATE customers
  SET status             = 'active',
      suspended_at       = NULL,
      suspended_by       = NULL,
      suspension_reason  = NULL
  WHERE id = p_customer_id;
  -- cascade_customer_reactivate trigger handles the restaurants side

  WITH updated AS (
    SELECT id FROM restaurants
    WHERE customer_id = p_customer_id
      AND status = 'active'
      AND suspended_at IS NULL
  )
  SELECT COUNT(*) INTO n FROM updated;
  restaurants_reactivated := n;
  RETURN NEXT;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 7c. Atomic undo-delete
CREATE OR REPLACE FUNCTION undo_delete_customer_cascade(p_customer_id UUID)
RETURNS TABLE(restaurants_reactivated INTEGER) AS $$
DECLARE
  n INTEGER;
BEGIN
  UPDATE customers
  SET status = 'active', deleted_at = NULL
  WHERE id = p_customer_id AND deleted_at IS NOT NULL;
  -- cascade_customer_reactivate trigger handles the restaurants side

  SELECT COUNT(*) INTO n
  FROM restaurants
  WHERE customer_id = p_customer_id
    AND status = 'active'
    AND suspended_at IS NULL;
  restaurants_reactivated := n;
  RETURN NEXT;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 7d. Atomic manual-link of an orphaned restaurant
CREATE OR REPLACE FUNCTION link_restaurant_to_customer(p_restaurant_id UUID, p_customer_id UUID)
RETURNS void AS $$
BEGIN
  UPDATE restaurants
  SET customer_id = p_customer_id
  WHERE id = p_restaurant_id AND customer_id IS NULL;

  INSERT INTO restaurant_team (restaurant_id, customer_id, role, status)
  VALUES (p_restaurant_id, p_customer_id, 'owner', 'active')
  ON CONFLICT (restaurant_id, customer_id) DO NOTHING;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMIT;

-- ============================================================================
-- DONE. Summary of changes: see TECHNICAL-REQUIREMENTS.md
-- ============================================================================
