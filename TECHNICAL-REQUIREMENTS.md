# StreetMenu — Technical Requirements

**Last updated:** 2026-04-18
Reflects the schema after running `supabase-optimization.sql`.

## Database — authoritative schema

All tables live in the `public` schema of the project's Supabase instance. Every row-mutating table has a `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()` and an auto-maintained `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()` (set by the `set_updated_at` trigger on every UPDATE).

### `customers`

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | `gen_random_uuid()` |
| phone | text | **UNIQUE NOT NULL** |
| name | text | NOT NULL |
| city | text | NOT NULL, default `''` |
| status | text | NOT NULL, default `'active'`, CHECK in `('active','suspended','deleted')` |
| suspended_at | timestamptz | nullable |
| suspended_by | text | CHECK in `('vendor','admin','system')` |
| suspension_reason | text | nullable |
| deleted_at | timestamptz | nullable |
| created_at | timestamptz | NOT NULL |
| updated_at | timestamptz | NOT NULL, auto |

Indexes: `customers_phone_key (UNIQUE)`, `idx_customers_status`, `idx_customers_deleted_at` (partial, WHERE deleted_at IS NOT NULL), `idx_customers_created_at`.

Triggers: `trg_customers_cascade_delete`, `trg_customers_cascade_reactivate`, `trg_customers_autolink`, `trg_customers_updated_at`.

### `restaurants`

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| name | text | NOT NULL |
| description | text | |
| address | text | |
| lat | double precision | NOT NULL |
| lng | double precision | NOT NULL |
| phone | text | |
| whatsapp | text | |
| logo_url, image_url | text | |
| is_open, is_active | boolean | NOT NULL, default true |
| city, neighborhood | text | |
| owner_name, cuisine_type | text | |
| **customer_id** | uuid | FK → `customers(id)` ON DELETE SET NULL; **NOT NULL after backfill** |
| status | text | NOT NULL, default `'pending'`, CHECK in `('pending','active','suspended','deleted')` |
| suspended_at, suspended_by, suspension_reason, deleted_at | | suspension metadata |
| created_at, updated_at | timestamptz | |

Indexes: `idx_restaurants_customer_id`, `idx_restaurants_status`, `idx_restaurants_is_active`, `idx_restaurants_whatsapp`, `idx_restaurants_city`, `idx_restaurants_created_at DESC`.

Triggers: `trg_restaurants_ensure_owner` (auto-creates `restaurant_team` owner row on INSERT), `trg_restaurants_updated_at`.

### `restaurant_team`

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| restaurant_id | uuid | FK → `restaurants(id)` ON DELETE CASCADE |
| customer_id | uuid | FK → `customers(id)` ON DELETE CASCADE |
| role | text | CHECK in `('owner','manager','staff')` |
| status | text | default `'active'`, CHECK in `('active','removed')` |
| added_by | uuid | FK → `customers(id)` ON DELETE SET NULL |
| added_at, updated_at | timestamptz | |
| | | UNIQUE `(restaurant_id, customer_id)` |

Indexes: `idx_team_restaurant_id`, `idx_team_customer_id`, `idx_team_status`.

### `menu_items`

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| restaurant_id | uuid | FK → `restaurants(id)` ON DELETE CASCADE |
| name | text | NOT NULL |
| description | text | |
| price | numeric(10,2) | NOT NULL, CHECK `price >= 0` |
| photo_url, category | text | |
| is_available | boolean | NOT NULL, default true |
| is_daily_special | boolean | NOT NULL, default false |
| created_at, updated_at | timestamptz | |

Indexes: `idx_menu_items_restaurant_id`, `idx_menu_items_is_available`, `idx_menu_items_rest_name` on `(restaurant_id, LOWER(name))` for WhatsApp name lookups.

### `orders`

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| restaurant_id | uuid | FK → `restaurants(id)` ON DELETE CASCADE |
| customer_id | uuid | FK → `customers(id)` ON DELETE SET NULL (nullable — guest orders allowed) |
| customer_name, customer_phone | text | snapshot for display |
| items | jsonb | legacy; source of truth for historical orders |
| total_price | numeric(10,2) | NOT NULL, CHECK `>= 0` |
| voucher_code | text | |
| discount_amount | numeric(10,2) | default 0 |
| status | text | CHECK in `('pending','confirmed','preparing','ready','completed')` |
| created_at, updated_at | timestamptz | |

Indexes: `idx_orders_restaurant_id`, `idx_orders_customer_id`, `idx_orders_status`, `idx_orders_created_at DESC`, and compound `idx_orders_rest_status (restaurant_id, status)` for the vendor dashboard.

### `order_items` (new — relational)

Sits alongside `orders.items` JSONB (which is preserved). Backfilled from JSONB on migration. Future write paths should insert here too.

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| order_id | uuid | FK → `orders(id)` ON DELETE CASCADE |
| menu_item_id | uuid | FK → `menu_items(id)` ON DELETE SET NULL (nullable — menu items can be deleted) |
| name | text | NOT NULL, snapshot at order time |
| price | numeric(10,2) | NOT NULL, CHECK `>= 0`, snapshot at order time |
| quantity | integer | NOT NULL, CHECK `> 0` |
| created_at | timestamptz | |

Indexes: `idx_order_items_order_id`, `idx_order_items_menu_item_id`.

### `vouchers`

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| code | text | **UNIQUE NOT NULL** |
| discount_type | text | CHECK in `('percent','fixed')` |
| discount_value | numeric(10,2) | NOT NULL |
| min_order | numeric(10,2) | default 0 |
| max_uses | integer | nullable = unlimited |
| uses_count | integer | default 0 |
| expires_at | timestamptz | nullable = no expiry |
| is_active | boolean | default true |
| city | text | nullable = all cities |
| **restaurant_id** | uuid | FK → `restaurants(id)` ON DELETE CASCADE, nullable = platform-wide |
| created_at, updated_at | timestamptz | |

Indexes: `idx_vouchers_code`, `idx_vouchers_is_active`, `idx_vouchers_restaurant_id`.

### `customer_vouchers`

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| customer_id | uuid | FK → `customers(id)` ON DELETE CASCADE |
| voucher_id | uuid | FK → `vouchers(id)` ON DELETE CASCADE |
| **order_id** | uuid | FK → `orders(id)` ON DELETE SET NULL, nullable (only set when the voucher is consumed) |
| claimed_at | timestamptz | NOT NULL |
| used_at | timestamptz | nullable |

Indexes: `idx_cv_customer_id`, `idx_cv_voucher_id`, `idx_cv_order_id`, `idx_cv_used_at`.

### `events`

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| title, description, venue, city, neighborhood, category, cover_photo, whatsapp, organizer_name | | |
| date | date | NOT NULL |
| time | text | |
| price | numeric(10,2) | |
| is_active | boolean | default false |
| **submitted_by** | uuid | FK → `customers(id)` ON DELETE SET NULL — who submitted it |
| **restaurant_id** | uuid | FK → `restaurants(id)` ON DELETE SET NULL, nullable — event hosted by a restaurant |
| created_at, updated_at | timestamptz | |

Indexes: `idx_events_city`, `idx_events_date`, `idx_events_is_active`, `idx_events_submitted_by`, `idx_events_restaurant_id`.

### `admin_users`

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| email | text | UNIQUE NOT NULL |
| password_hash, name | text | NOT NULL |
| role | text | CHECK in `('super_admin','admin','moderator')` |
| status | text | default `'active'`, CHECK in `('active','suspended')` |
| created_by | uuid | FK → `admin_users(id)` ON DELETE SET NULL |
| created_at, updated_at | timestamptz | |

Indexes: `idx_admin_users_role`, `idx_admin_users_status`.

### `verification_codes`, `signup_sessions`

Ephemeral WhatsApp onboarding tables. Both already have service-role-only RLS.

Added indexes: `idx_vcodes_phone`, `idx_vcodes_expires_at`, `idx_sessions_user_type`, `idx_sessions_expires_at`.

## Integrity rules enforced by the database

| Rule | Mechanism |
|---|---|
| Every restaurant has a customer_id after the migration | Backfill + NOT NULL (conditional) |
| Every restaurant has an owner row in `restaurant_team` | Backfill + `trg_restaurants_ensure_owner` trigger |
| Deleting a customer (soft) suspends their restaurants with `suspended_by='system'` | `trg_customers_cascade_delete` |
| Reactivating a customer reactivates only the system-suspended restaurants | `trg_customers_cascade_reactivate` |
| Creating a customer via WhatsApp auto-links any orphaned restaurants with matching phone | `trg_customers_autolink` |
| `updated_at` reflects the last write on every table | `set_updated_at` trigger on each table |
| Enum-like status/role columns reject unknown values | CHECK constraints (see per-table notes) |
| `menu_items.price` and `orders.total_price` can't go negative | CHECK `>= 0` |
| Guest orders allowed (customer_id nullable) but authenticated orders linked to customer | FK + backfill |
| Restaurant-specific vouchers scoped via `vouchers.restaurant_id` | FK with ON DELETE CASCADE |

## RPC functions (transactional)

| Function | Use from | Returns |
|---|---|---|
| `delete_customer_cascade(p_customer_id)` | `/api/accounts/[id]/delete` | `restaurants_suspended: int` |
| `reactivate_customer_cascade(p_customer_id)` | `/api/accounts/[id]/reactivate` | `restaurants_reactivated: int` |
| `undo_delete_customer_cascade(p_customer_id)` | `/api/accounts/[id]/undo-delete` | `restaurants_reactivated: int` |
| `link_restaurant_to_customer(p_restaurant_id, p_customer_id)` | manual-link branch of `/api/admin/orphaned-restaurants` | void |

All four use `SECURITY DEFINER` so they run with schema owner privileges. The TypeScript routes call them with `supabaseAdmin.rpc(...)`.

## Known outstanding items (not enforced by the migration)

These are real but were intentionally left to application code because enforcing them in SQL would be too invasive:

- Orders for deleted/suspended restaurants should be readable in history but should not accept new writes — enforce in the create-order API route, not the schema.
- Vendor create/edit of restaurant-scoped vouchers — UI work, outside this migration's scope.
- Rewriting legacy `orders.items` JSONB reads to use `order_items` — the schema is now ready; read-path migration is deferred.

## Running the migration

1. Open Supabase SQL editor on the project DB.
2. Paste the full contents of `supabase-optimization.sql` and Run.
3. The script emits `RAISE NOTICE` lines for any skipped step (e.g. if orphaned restaurants still exist, the NOT NULL step is skipped with a count).
4. The script is idempotent — re-running it is safe.
