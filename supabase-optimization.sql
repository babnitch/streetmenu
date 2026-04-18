-- ============================================================================
-- STREETMENU DATABASE OPTIMIZATION MIGRATION
-- ----------------------------------------------------------------------------
-- Safe, idempotent. Re-running is a no-op. Never DROPs or DELETEs data.
--
-- Structure (ordered so every reference is to something the previous phase
-- already guaranteed exists):
--
--   Phase 1: CREATE TABLE IF NOT EXISTS   — minimal scaffolds in dep order
--   Phase 2: ALTER TABLE ADD COLUMN       — every column the migration touches
--   Phase 3: ADD CONSTRAINTS (FK, UNIQUE) — conditional on absence
--   Phase 4: CREATE INDEX IF NOT EXISTS
--   Phase 5: BACKFILLS (data migration)
--   Phase 6: CHECK + conditional NOT NULL
--   Phase 7: Triggers, trigger functions, RPCs
-- ============================================================================

BEGIN;

-- ============================================================================
-- PHASE 0: Extensions
-- ============================================================================
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================================
-- PHASE 1: Ensure tables exist (minimal scaffold, dependency order)
-- ----------------------------------------------------------------------------
-- CREATE TABLE IF NOT EXISTS leaves any pre-existing table untouched; Phase 2
-- handles adding missing columns to those. For fresh DBs these scaffolds are
-- filled out column-by-column in Phase 2.
-- ============================================================================

CREATE TABLE IF NOT EXISTS customers (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone      TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin_users (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email      TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS restaurants (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS restaurant_team (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL,
  customer_id   UUID NOT NULL,
  added_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS menu_items (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL,
  name          TEXT NOT NULL DEFAULT '',
  price         NUMERIC(10,2) NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS orders (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS vouchers (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS customer_vouchers (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL,
  voucher_id  UUID NOT NULL,
  claimed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS events (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  city       TEXT NOT NULL DEFAULT '',
  date       DATE NOT NULL DEFAULT CURRENT_DATE,
  category   TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS verification_codes (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone      TEXT NOT NULL,
  code       TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used       BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS signup_sessions (
  phone      TEXT PRIMARY KEY,
  user_type  TEXT NOT NULL,
  step       INTEGER NOT NULL DEFAULT 1,
  data       JSONB NOT NULL DEFAULT '{}'::jsonb,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS order_items (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id   UUID NOT NULL,
  name       TEXT NOT NULL DEFAULT '',
  price      NUMERIC(10,2) NOT NULL DEFAULT 0,
  quantity   INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- PHASE 2: Ensure every column exists. Safe to re-run — each is IF NOT EXISTS.
-- ============================================================================

-- customers
ALTER TABLE customers ADD COLUMN IF NOT EXISTS name              TEXT NOT NULL DEFAULT '';
ALTER TABLE customers ADD COLUMN IF NOT EXISTS city              TEXT NOT NULL DEFAULT '';
ALTER TABLE customers ADD COLUMN IF NOT EXISTS status            TEXT NOT NULL DEFAULT 'active';
ALTER TABLE customers ADD COLUMN IF NOT EXISTS suspended_at      TIMESTAMPTZ;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS suspended_by      TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS suspension_reason TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS deleted_at        TIMESTAMPTZ;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- admin_users
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS password_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS name          TEXT NOT NULL DEFAULT '';
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS role          TEXT NOT NULL DEFAULT 'moderator';
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS status        TEXT NOT NULL DEFAULT 'active';
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS created_by    UUID;
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- restaurants
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS name              TEXT NOT NULL DEFAULT '';
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS description       TEXT;
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS address           TEXT;
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS lat               DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS lng               DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS phone             TEXT;
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS whatsapp          TEXT;
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS logo_url          TEXT;
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS image_url         TEXT;
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS is_open           BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS is_active         BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS city              TEXT;
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS neighborhood      TEXT;
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS owner_name        TEXT;
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS cuisine_type      TEXT;
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS customer_id       UUID;
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS status            TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS suspended_at      TIMESTAMPTZ;
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS suspended_by      TEXT;
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS suspension_reason TEXT;
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS deleted_at        TIMESTAMPTZ;
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- restaurant_team
ALTER TABLE restaurant_team ADD COLUMN IF NOT EXISTS role       TEXT NOT NULL DEFAULT 'owner';
ALTER TABLE restaurant_team ADD COLUMN IF NOT EXISTS status     TEXT NOT NULL DEFAULT 'active';
ALTER TABLE restaurant_team ADD COLUMN IF NOT EXISTS added_by   UUID;
ALTER TABLE restaurant_team ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- menu_items
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS description      TEXT;
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS photo_url        TEXT;
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS category         TEXT;
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS is_available     BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS is_daily_special BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- orders
ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_id     UUID;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_name   TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_phone  TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS items           JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS total_price     NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS voucher_code    TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(10,2) DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS status          TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- vouchers
ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS discount_type  TEXT NOT NULL DEFAULT 'percent';
ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS discount_value NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS min_order      NUMERIC(10,2) DEFAULT 0;
ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS max_uses       INTEGER;
ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS uses_count     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS expires_at     TIMESTAMPTZ;
ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS is_active      BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS city           TEXT;
ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS restaurant_id  UUID;
ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- customer_vouchers
ALTER TABLE customer_vouchers ADD COLUMN IF NOT EXISTS used_at    TIMESTAMPTZ;
ALTER TABLE customer_vouchers ADD COLUMN IF NOT EXISTS order_id   UUID;
ALTER TABLE customer_vouchers ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- events
ALTER TABLE events ADD COLUMN IF NOT EXISTS title          TEXT NOT NULL DEFAULT '';
ALTER TABLE events ADD COLUMN IF NOT EXISTS description    TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS time           TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS venue          TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS neighborhood   TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS price          NUMERIC(10,2);
ALTER TABLE events ADD COLUMN IF NOT EXISTS cover_photo    TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS whatsapp       TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS organizer_name TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS is_active      BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE events ADD COLUMN IF NOT EXISTS submitted_by   UUID;
ALTER TABLE events ADD COLUMN IF NOT EXISTS restaurant_id  UUID;
ALTER TABLE events ADD COLUMN IF NOT EXISTS updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- order_items (FK column)
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS menu_item_id UUID;

-- ============================================================================
-- PHASE 3: Foreign keys and UNIQUE constraints — only if missing
-- ============================================================================
-- Detection: check pg_constraint by column set rather than by name, so we
-- don't re-add an FK/UNIQUE that was created under a different name in a
-- prior migration.
-- ============================================================================

-- Helper: add FK iff no FK already exists on (table, column)
CREATE OR REPLACE FUNCTION _smo_add_fk(
  p_table       regclass,
  p_column      text,
  p_ref_table   regclass,
  p_ref_column  text,
  p_on_delete   text    -- 'CASCADE' | 'SET NULL' | 'NO ACTION'
) RETURNS void AS $$
DECLARE
  col_attnum smallint;
  cname      text;
BEGIN
  SELECT attnum INTO col_attnum FROM pg_attribute
  WHERE attrelid = p_table AND attname = p_column AND NOT attisdropped;
  IF col_attnum IS NULL THEN RETURN; END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = p_table AND contype = 'f'
      AND conkey = ARRAY[col_attnum]::smallint[]
  ) THEN
    RETURN;
  END IF;

  cname := format('%s_%s_fkey', split_part(p_table::text, '.', -1), p_column);
  EXECUTE format(
    'ALTER TABLE %s ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES %s(%I) ON DELETE %s',
    p_table, cname, p_column, p_ref_table, p_ref_column, p_on_delete
  );
END;
$$ LANGUAGE plpgsql;

-- Helper: add UNIQUE iff no UNIQUE constraint/index already covers these columns
CREATE OR REPLACE FUNCTION _smo_add_unique(
  p_table    regclass,
  p_columns  text[]
) RETURNS void AS $$
DECLARE
  col_attnums smallint[] := ARRAY[]::smallint[];
  a           smallint;
  col         text;
  cname       text;
BEGIN
  FOREACH col IN ARRAY p_columns LOOP
    SELECT attnum INTO a FROM pg_attribute
    WHERE attrelid = p_table AND attname = col AND NOT attisdropped;
    IF a IS NULL THEN RETURN; END IF;
    col_attnums := col_attnums || a;
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = p_table AND contype IN ('u','p')
      AND conkey = col_attnums
  ) THEN
    RETURN;
  END IF;

  cname := format('%s_%s_key', split_part(p_table::text, '.', -1), array_to_string(p_columns, '_'));
  EXECUTE format(
    'ALTER TABLE %s ADD CONSTRAINT %I UNIQUE (%s)',
    p_table, cname, array_to_string(p_columns, ',')
  );
END;
$$ LANGUAGE plpgsql;

-- FKs
SELECT _smo_add_fk('admin_users',       'created_by',    'admin_users',  'id', 'SET NULL');
SELECT _smo_add_fk('restaurants',       'customer_id',   'customers',    'id', 'SET NULL');
SELECT _smo_add_fk('restaurant_team',   'restaurant_id', 'restaurants',  'id', 'CASCADE');
SELECT _smo_add_fk('restaurant_team',   'customer_id',   'customers',    'id', 'CASCADE');
SELECT _smo_add_fk('restaurant_team',   'added_by',      'customers',    'id', 'SET NULL');
SELECT _smo_add_fk('menu_items',        'restaurant_id', 'restaurants',  'id', 'CASCADE');
SELECT _smo_add_fk('orders',            'restaurant_id', 'restaurants',  'id', 'CASCADE');
SELECT _smo_add_fk('orders',            'customer_id',   'customers',    'id', 'SET NULL');
SELECT _smo_add_fk('order_items',       'order_id',      'orders',       'id', 'CASCADE');
SELECT _smo_add_fk('order_items',       'menu_item_id',  'menu_items',   'id', 'SET NULL');
SELECT _smo_add_fk('vouchers',          'restaurant_id', 'restaurants',  'id', 'CASCADE');
SELECT _smo_add_fk('customer_vouchers', 'customer_id',   'customers',    'id', 'CASCADE');
SELECT _smo_add_fk('customer_vouchers', 'voucher_id',    'vouchers',     'id', 'CASCADE');
SELECT _smo_add_fk('customer_vouchers', 'order_id',      'orders',       'id', 'SET NULL');
SELECT _smo_add_fk('events',            'submitted_by',  'customers',    'id', 'SET NULL');
SELECT _smo_add_fk('events',            'restaurant_id', 'restaurants',  'id', 'SET NULL');

-- UNIQUE
SELECT _smo_add_unique('customers',       ARRAY['phone']);
SELECT _smo_add_unique('admin_users',     ARRAY['email']);
SELECT _smo_add_unique('vouchers',        ARRAY['code']);
SELECT _smo_add_unique('restaurant_team', ARRAY['restaurant_id','customer_id']);

DROP FUNCTION _smo_add_fk(regclass, text, regclass, text, text);
DROP FUNCTION _smo_add_unique(regclass, text[]);

-- ============================================================================
-- PHASE 4: Indexes (every FK + every hot filter column)
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
CREATE INDEX IF NOT EXISTS idx_orders_rest_status       ON orders(restaurant_id, status);

-- menu_items
CREATE INDEX IF NOT EXISTS idx_menu_items_restaurant_id ON menu_items(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_menu_items_is_available  ON menu_items(is_available);
CREATE INDEX IF NOT EXISTS idx_menu_items_rest_name     ON menu_items(restaurant_id, LOWER(name));

-- order_items
CREATE INDEX IF NOT EXISTS idx_order_items_order_id     ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_menu_item_id ON order_items(menu_item_id);

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
-- PHASE 5: Backfills — safe now, every table/column/FK is guaranteed
-- ============================================================================

-- 5a. Link orphaned restaurants: match by phone, else create a customer from
--     the restaurant's own details. Adds owner row in restaurant_team.
DO $$
DECLARE
  r        RECORD;
  cust_id  UUID;
BEGIN
  FOR r IN
    SELECT id, name, whatsapp, city FROM restaurants WHERE customer_id IS NULL
  LOOP
    IF r.whatsapp IS NULL OR r.whatsapp = '' THEN
      CONTINUE;  -- can't match or create without a phone
    END IF;

    SELECT id INTO cust_id FROM customers WHERE phone = r.whatsapp LIMIT 1;

    IF cust_id IS NULL THEN
      INSERT INTO customers (name, phone, city, status)
      VALUES (COALESCE(NULLIF(r.name,''), 'Restaurant'), r.whatsapp,
              COALESCE(r.city, ''), 'active')
      RETURNING id INTO cust_id;
    END IF;

    UPDATE restaurants SET customer_id = cust_id WHERE id = r.id;

    INSERT INTO restaurant_team (restaurant_id, customer_id, role, status)
    VALUES (r.id, cust_id, 'owner', 'active')
    ON CONFLICT (restaurant_id, customer_id) DO NOTHING;
  END LOOP;
END $$;

-- 5b. Every restaurant with a customer_id must have an owner row in team.
INSERT INTO restaurant_team (restaurant_id, customer_id, role, status)
SELECT r.id, r.customer_id, 'owner', 'active'
FROM restaurants r
WHERE r.customer_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM restaurant_team t
    WHERE t.restaurant_id = r.id AND t.customer_id = r.customer_id
  )
ON CONFLICT (restaurant_id, customer_id) DO NOTHING;

-- 5c. Backfill orders.customer_id from customer_phone.
UPDATE orders o
SET customer_id = c.id
FROM customers c
WHERE o.customer_id IS NULL
  AND o.customer_phone IS NOT NULL
  AND o.customer_phone <> ''
  AND c.phone = o.customer_phone;

-- 5d. Backfill events.submitted_by by matching events.whatsapp against a customer.
UPDATE events e
SET submitted_by = c.id
FROM customers c
WHERE e.submitted_by IS NULL
  AND e.whatsapp IS NOT NULL
  AND e.whatsapp <> ''
  AND c.phone = e.whatsapp;

-- 5e. Backfill order_items from orders.items JSONB. Matches menu_items by
--     (restaurant_id, LOWER(name)); unmatched items still get a row with
--     menu_item_id = NULL (historical snapshot).
DO $$
DECLARE
  o     RECORD;
  item  JSONB;
  mi_id UUID;
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
        GREATEST(COALESCE((item->>'quantity')::INTEGER, 1), 1)
      );
    END LOOP;
  END LOOP;
END $$;

-- ============================================================================
-- PHASE 6: CHECK constraints + conditional NOT NULL
-- ============================================================================

-- Helper: add CHECK iff no CHECK with this name exists
CREATE OR REPLACE FUNCTION _smo_add_check(
  p_table regclass,
  p_name  text,
  p_check text
) RETURNS void AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = p_name) THEN
    BEGIN
      EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I CHECK (%s)', p_table, p_name, p_check);
    EXCEPTION WHEN others THEN
      RAISE NOTICE 'CHECK % on % skipped: %', p_name, p_table, SQLERRM;
    END;
  END IF;
END;
$$ LANGUAGE plpgsql;

SELECT _smo_add_check('customers',       'customers_status_chk',          $c$status IN ('active','suspended','deleted')$c$);
SELECT _smo_add_check('customers',       'customers_suspended_by_chk',    $c$suspended_by IS NULL OR suspended_by IN ('vendor','admin','system')$c$);
SELECT _smo_add_check('restaurants',     'restaurants_status_chk',        $c$status IN ('pending','active','suspended','deleted')$c$);
SELECT _smo_add_check('restaurants',     'restaurants_suspended_by_chk',  $c$suspended_by IS NULL OR suspended_by IN ('vendor','admin','system')$c$);
SELECT _smo_add_check('restaurant_team', 'restaurant_team_role_chk',      $c$role IN ('owner','manager','staff')$c$);
SELECT _smo_add_check('restaurant_team', 'restaurant_team_status_chk',    $c$status IN ('active','removed')$c$);
SELECT _smo_add_check('admin_users',     'admin_users_role_chk',          $c$role IN ('super_admin','admin','moderator')$c$);
SELECT _smo_add_check('admin_users',     'admin_users_status_chk',        $c$status IN ('active','suspended')$c$);
SELECT _smo_add_check('orders',          'orders_status_chk',             $c$status IN ('pending','confirmed','preparing','ready','completed')$c$);
SELECT _smo_add_check('orders',          'orders_total_price_nonneg',     $c$total_price >= 0$c$);
SELECT _smo_add_check('menu_items',      'menu_items_price_nonneg',       $c$price >= 0$c$);
SELECT _smo_add_check('vouchers',        'vouchers_discount_type_chk',    $c$discount_type IN ('percent','fixed')$c$);
SELECT _smo_add_check('order_items',     'order_items_quantity_pos',      $c$quantity > 0$c$);
SELECT _smo_add_check('order_items',     'order_items_price_nonneg',      $c$price >= 0$c$);

DROP FUNCTION _smo_add_check(regclass, text, text);

-- customers.phone NOT NULL
DO $$
BEGIN
  BEGIN
    ALTER TABLE customers ALTER COLUMN phone SET NOT NULL;
  EXCEPTION WHEN others THEN
    RAISE NOTICE 'customers.phone NOT NULL skipped: %', SQLERRM;
  END;
END $$;

-- restaurants.customer_id NOT NULL — only when backfill left no orphans.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM restaurants WHERE customer_id IS NULL) THEN
    BEGIN
      ALTER TABLE restaurants ALTER COLUMN customer_id SET NOT NULL;
    EXCEPTION WHEN others THEN
      RAISE NOTICE 'restaurants.customer_id NOT NULL skipped: %', SQLERRM;
    END;
  ELSE
    RAISE NOTICE 'restaurants.customer_id: % orphaned rows remain; NOT NULL skipped',
      (SELECT COUNT(*) FROM restaurants WHERE customer_id IS NULL);
  END IF;
END $$;

-- ============================================================================
-- PHASE 7: Triggers + RPC functions
-- ============================================================================

-- 7a. updated_at auto-update
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

-- 7b. New restaurant → auto-create owner row
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

-- 7c. Customer soft-deleted → suspend their active/pending restaurants
CREATE OR REPLACE FUNCTION cascade_customer_delete() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'deleted' AND (OLD.status IS DISTINCT FROM 'deleted') THEN
    UPDATE restaurants
    SET status            = 'suspended',
        suspended_at      = NOW(),
        suspended_by      = 'system',
        suspension_reason = 'Account deleted'
    WHERE customer_id = NEW.id
      AND status IN ('active','pending');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_customers_cascade_delete ON customers;
CREATE TRIGGER trg_customers_cascade_delete
  AFTER UPDATE OF status ON customers
  FOR EACH ROW EXECUTE FUNCTION cascade_customer_delete();

-- 7d. Customer reactivated → un-suspend system-suspended restaurants
CREATE OR REPLACE FUNCTION cascade_customer_reactivate() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'active' AND OLD.status IN ('suspended','deleted') THEN
    UPDATE restaurants
    SET status            = 'active',
        suspended_at      = NULL,
        suspended_by      = NULL,
        suspension_reason = NULL
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

-- 7e. New customer → auto-link any orphaned restaurants whose whatsapp matches
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

-- 7f. RPC: delete_customer_cascade (the trigger does the work; this is the
--     single-call version for API callers)
CREATE OR REPLACE FUNCTION delete_customer_cascade(p_customer_id UUID)
RETURNS TABLE(restaurants_suspended INTEGER) AS $$
DECLARE n INTEGER;
BEGIN
  SELECT COUNT(*) INTO n FROM restaurants
  WHERE customer_id = p_customer_id AND status IN ('active','pending');

  UPDATE customers SET status = 'deleted', deleted_at = NOW()
  WHERE id = p_customer_id AND status <> 'deleted';

  restaurants_suspended := n;
  RETURN NEXT;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 7g. RPC: reactivate_customer_cascade
CREATE OR REPLACE FUNCTION reactivate_customer_cascade(p_customer_id UUID)
RETURNS TABLE(restaurants_reactivated INTEGER) AS $$
DECLARE n INTEGER;
BEGIN
  SELECT COUNT(*) INTO n FROM restaurants
  WHERE customer_id = p_customer_id AND suspended_by = 'system';

  UPDATE customers
  SET status = 'active', suspended_at = NULL, suspended_by = NULL, suspension_reason = NULL
  WHERE id = p_customer_id;

  restaurants_reactivated := n;
  RETURN NEXT;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 7h. RPC: undo_delete_customer_cascade
CREATE OR REPLACE FUNCTION undo_delete_customer_cascade(p_customer_id UUID)
RETURNS TABLE(restaurants_reactivated INTEGER) AS $$
DECLARE n INTEGER;
BEGIN
  SELECT COUNT(*) INTO n FROM restaurants
  WHERE customer_id = p_customer_id AND suspended_by = 'system';

  UPDATE customers SET status = 'active', deleted_at = NULL
  WHERE id = p_customer_id AND deleted_at IS NOT NULL;

  restaurants_reactivated := n;
  RETURN NEXT;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 7i. RPC: link_restaurant_to_customer (manual orphan link)
CREATE OR REPLACE FUNCTION link_restaurant_to_customer(p_restaurant_id UUID, p_customer_id UUID)
RETURNS void AS $$
BEGIN
  UPDATE restaurants SET customer_id = p_customer_id
  WHERE id = p_restaurant_id AND customer_id IS NULL;

  INSERT INTO restaurant_team (restaurant_id, customer_id, role, status)
  VALUES (p_restaurant_id, p_customer_id, 'owner', 'active')
  ON CONFLICT (restaurant_id, customer_id) DO NOTHING;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMIT;

-- ============================================================================
-- DONE. The script is idempotent — re-run any time.
-- ============================================================================
