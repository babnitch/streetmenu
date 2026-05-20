# Tchop & Ndjoka — Technical Requirements (v4.0)

**Last updated:** 2026-05-20
**Repo:** github.com/babnitch/streetmenu
**Live:** https://streetmenu.vercel.app

For the *what* of the product see `FUNCTIONAL-SPEC.md`. For phased delivery see `ROADMAP.md`.

---

## 1. Architecture

```
                ┌────────────────────────┐
                │  Browsers / Mobile     │
                │  (PWA-ready Next.js)   │
                └─────────────┬──────────┘
                              │ HTTPS
                ┌─────────────▼──────────────┐
                │  Vercel Edge + Functions   │
                │  • Next.js 14 App Router   │
                │  • API routes (Node 24)    │
                │  • Image Optimization      │
                └─────┬──────────────┬───────┘
                      │              │
       ┌──────────────▼──┐  ┌────────▼────────┐
       │  Supabase       │  │  Twilio         │
       │  • Postgres 15  │  │  • WhatsApp     │
       │  • Storage      │  │    incoming     │
       │  • Service-role │  │    + outbound   │
       └─────────┬───────┘  └─────────────────┘
                 │
       ┌─────────▼─────────┐    ┌──────────────────┐
       │  PawaPay          │    │  Mapbox          │
       │  • Deposits       │    │  • Tiles + style │
       │  • Payouts        │    │  • Geocoding —   │
       │  • Webhook        │    │    (TBD)         │
       └───────────────────┘    └──────────────────┘
```

- **Hosting**: Vercel (PR previews on push, prod on `main`). CDN-cached static assets, edge-functions for `/api/*`.
- **DB + storage**: single Supabase project. App talks via:
  - `lib/supabase.ts` — anonymous client for public reads on the browser
  - `lib/supabaseAdmin.ts` — service-role client for all server-side mutations (every `/api/*` route)
- All table writes go through API routes (never client-direct) so RLS stays `service_role_only`.

---

## 2. Tech stack

| Layer | Choice | Version |
|---|---|---|
| Framework | Next.js (App Router) | `14.2.35` |
| Runtime | Node.js | 24 LTS (Vercel default) |
| Language | TypeScript | `^5` |
| UI | React | `^18` |
| Styling | Tailwind CSS | `^3.4.1` |
| DB | Supabase Postgres | 15 |
| Auth | JWT (jsonwebtoken) + bcryptjs | `^9.0.3` / `^3.0.3` |
| Maps | Mapbox GL JS + react-map-gl | `^3.21.0` / `^8.1.0` |
| WhatsApp | Twilio REST API (HTTP, no SDK) | — |
| Payments | PawaPay v1 REST | sandbox + prod |
| QR | qrcode.react | `^4.2.0` |
| Hosting | Vercel | — |

No state-management library — context providers (`cartContext`, `cityContext`, `languageContext`, `authContext`, `modeContext`) cover the small amount of shared client state.

---

## 3. API routes

95 routes total. Grouped by domain:

### 3.1 Auth (10)
- `POST /api/auth/send-code` — issue WhatsApp OTP
- `POST /api/auth/verify-code` — exchange OTP for `sm_session` cookie
- `POST /api/auth/check-phone` — pre-flight check before send-code
- `POST /api/auth/logout`
- `GET  /api/auth/me`
- `GET  /api/auth/profile` / `POST /api/auth/update-profile`
- `POST /api/auth/nickname`
- `POST /api/auth/admin-login`
- `POST /api/auth/admin-change-password`
- `GET  /api/auth/admin-profile` / `POST /api/auth/admin-update-profile`

### 3.2 Restaurants (16)
- `GET  /api/restaurants/[id]`
- `POST /api/restaurants/[id]/approve` (admin)
- `POST /api/restaurants/[id]/suspend` / `reactivate` / `delete` / `undo-delete` (admin)
- `POST /api/restaurants/[id]/image` (owner)
- `GET  /api/restaurants/[id]/hours` / `PATCH …` (owner)
- `POST /api/restaurants/[id]/override` — manual open/close (owner)
- `POST /api/restaurants/[id]/payment` — toggle payment_enabled + payout phone (owner)
- `GET  /api/restaurants/[id]/rate` (customer) / `POST /api/restaurants/[id]/rate`
- `GET  /api/restaurants/[id]/rating` — aggregate
- `GET  /api/restaurants/[id]/team` / `POST /api/restaurants/[id]/team/[memberId]` (owner)
- `POST /api/restaurants/[id]/invite` / `DELETE /api/restaurants/[id]/invite/[invitationId]`
- `GET  /api/restaurants/open-status?ids=…` — bulk computed open status (60s edge cache)
- `GET  /api/restaurants/ratings-summary?ids=…`

### 3.3 Orders (3)
- `POST /api/orders/[id]/status` — vendor advances state
- `POST /api/orders/[id]/mark-paid` — vendor records manual MoMo / cash
- `POST /api/payments/initiate` — start PawaPay deposit for an order

### 3.4 Payments (4)
- `POST /api/payments/initiate`
- `GET  /api/payments/status/[depositId]`
- `POST /api/payments/webhook` — handles deposits for orders / event reservations / broadcasts / promotions, plus payout callbacks
- `POST /api/payments/payout` — admin-triggered vendor payout

### 3.5 Events (16)
- `POST /api/events/submit`
- `GET  /api/events/my`
- `GET  /api/events/likes-summary?ids=…`
- `GET  /api/events/[id]/reservations` (organizer)
- `POST /api/events/[id]/reserve` — accepts `{ quantity }` OR `{ items: [{ tier_id, quantity }] }`
- `POST /api/events/[id]/pay` — single-tier PawaPay checkout
- `POST /api/events/[id]/reservations/[resId]/attend` / `cancel` / `confirm` / `reject`
- `PATCH /api/events/[id]/reservations-status` — open/close gate
- `PATCH /api/events/[id]/settings` — requires_confirmation + max_tickets
- `GET  /api/events/[id]/tiers` / `POST /api/events/[id]/tiers`
- `PATCH /api/events/[id]/tiers/[tierId]` / `DELETE` (soft)
- `GET  /api/events/[id]/likes` / `POST /api/events/[id]/like`
- `GET  /api/events/[id]/comments` / `POST /api/events/[id]/comments` / `DELETE /api/events/[id]/comments/[commentId]`

### 3.6 Subscriptions (4)
- `POST /api/subscriptions/subscribe`
- `POST /api/subscriptions/unsubscribe`
- `GET  /api/subscriptions/my`
- `PATCH /api/subscriptions/[id]`

### 3.7 Broadcasts (5)
- `POST /api/broadcasts/create` — inserts draft + creates PawaPay deposit
- `POST /api/broadcasts/[id]/send` — fan-out, fired by webhook on `paid`
- `GET  /api/broadcasts/eligibility`
- `POST /api/broadcasts/preview` — recipient count + cost
- `GET  /api/broadcasts/my`

### 3.8 Promotions (7)
- `POST /api/promotions` — create + deposit
- `GET  /api/promotions/eligibility` / `my`
- `PATCH /api/promotions/[id]` — pause/resume/cancel
- `POST /api/promotions/[id]/impression` / `click`
- `GET  /api/promotions/active?city=…&type=restaurant|event[&placement=banner]`

### 3.9 Vouchers (5)
- `POST /api/customer/vouchers/claim`
- `POST /api/customer/vouchers/apply` — checkout validation
- `POST /api/customer/vouchers/consume` — server marks `used_at`
- `GET  /api/vendor/vouchers` / `POST` / `PATCH/DELETE` via `/api/vendor/vouchers/[id]`

### 3.10 Vendor (4)
- `GET /api/vendor/restaurants` / `pending-count` / `vouchers` / `ratings/[restaurantId]`

### 3.11 Customer (1)
- `GET /api/customer/reservations`

### 3.12 Reports (1)
- `POST /api/reports`

### 3.13 Admin (17)
- `GET  /api/admin/accounts` / `POST /api/accounts/[id]/{suspend,reactivate,delete,undo-delete,release-number}`
- `GET  /api/admin/accounts/[id]/restaurants`
- `GET  /api/admin/orphaned-restaurants`
- `POST /api/admin/events/[id]/approve` / `reject`
- `POST /api/admin/events/revoke-auto-approve/[customerId]`
- `GET  /api/admin/broadcasts` / `POST /api/admin/broadcasts/block-sender` / `PATCH /api/admin/broadcasts/pricing` / `GET /api/admin/broadcasts/stats`
- `GET  /api/admin/promotions` / `POST /api/admin/promotions/[id]/approve` / `reject` / `GET+PATCH /api/admin/promotions/pricing`
- `GET  /api/admin/reports` / `PATCH /api/admin/reports/[id]`
- `GET  /api/admin/team` / `POST /api/admin/team/[memberId]`
- `GET  /api/admin/vouchers` / `POST` / `PATCH/DELETE /api/admin/vouchers/[id]`
- `POST /api/admin/cleanup-expired` — cron (daily 02:00 via `vercel.json`)
- `POST /api/admin/auth` — legacy admin login helper

### 3.14 WhatsApp (2)
- `POST /api/whatsapp/incoming` — Twilio webhook
- `POST /api/whatsapp/notify-order` — order status WhatsApp ping helper

---

## 4. Database — 26 tables

All in the `public` schema. Every table has `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`; most also have an `updated_at TIMESTAMPTZ` maintained by a `set_updated_at` trigger.

### 4.1 Core auth + identity

#### `customers`
`id` UUID PK, `phone` TEXT UNIQUE NOT NULL, `name` TEXT NOT NULL, `city` TEXT DEFAULT `''`, `status` TEXT CHECK in (`active`,`suspended`,`deleted`), `suspended_at`, `suspended_by`, `suspension_reason`, `deleted_at`, `nickname`, `nickname_updated_at`, `momo_phone`, `events_submitted_count` INT, `events_approved_count` INT, `event_auto_approve` BOOL, `broadcast_blocked` BOOL.

#### `admin_users`
`id` UUID PK, `email` TEXT UNIQUE NOT NULL, `password_hash` TEXT, `name` TEXT, `role` TEXT CHECK in (`super_admin`,`admin`,`moderator`), `created_at`.

#### `verification_codes`
`id` UUID PK, `phone` TEXT, `code` TEXT (6-digit), `expires_at` TIMESTAMPTZ, `used` BOOL, `attempts` INT, `created_at`.

#### `signup_sessions`
`phone` TEXT PK, `user_type` TEXT, `step` INT, `data` JSONB, `expires_at`. Tracks multi-step WhatsApp onboarding + ordering sessions.

### 4.2 Restaurants

#### `restaurants`
`id` UUID PK, `name`, `description`, `address`, `city`, `lat` NUMERIC, `lng` NUMERIC, `phone`, `whatsapp`, `logo_url`, `image_url`, `cuisine_type`, `neighborhood`, `owner_name`, `is_open` BOOL, `is_active` BOOL, `customer_id` UUID FK → customers, `status` TEXT CHECK (`pending`,`active`,`approved`,`suspended`,`deleted`), `suspended_at`, `suspended_by`, `suspension_reason`, `deleted_at`, `payment_enabled` BOOL, `pawapay_merchant_id` TEXT, `payout_phone` TEXT, `manual_override` TEXT (`open`,`closed`,null), `manual_override_at`, `timezone` TEXT, `allow_orders_when_closed` BOOL, `prep_time_min` INT, `prep_time_max` INT.

#### `menu_items`
`id` UUID PK, `restaurant_id` UUID FK, `name`, `description`, `price` INT, `photo_url`, `category` TEXT, `is_available` BOOL, `is_daily_special` BOOL.

#### `restaurant_hours`
`id` UUID PK, `restaurant_id` UUID FK, `day_of_week` SMALLINT 0–6, `open_time` TIME, `close_time` TIME, `is_closed` BOOL. UNIQUE (`restaurant_id`,`day_of_week`).

#### `restaurant_team`
`id` UUID PK, `restaurant_id` UUID FK, `customer_id` UUID FK, `role` TEXT (`owner`,`manager`,`staff`), `status` TEXT (`active`,`removed`), `added_by`, `added_at`. UNIQUE (`restaurant_id`,`customer_id`).

#### `team_invitations`
`id` UUID PK, `restaurant_id`, `phone` TEXT, `role` TEXT, `invited_by` UUID, `status` TEXT (`pending`,`accepted`,`declined`,`cancelled`,`expired`), `expires_at`, `accepted_at`. Partial UNIQUE index on (`restaurant_id`,`phone`) WHERE status='pending'.

#### `restaurant_ratings`
`id` UUID PK, `restaurant_id` UUID FK, `customer_id` UUID FK, `stars` SMALLINT 1–5, `tags` TEXT[] (`food`,`service`,`value`,`cleanliness`), `comment` TEXT, `updated_at`. UNIQUE (`restaurant_id`,`customer_id`).

### 4.3 Orders + payments

#### `orders`
`id` UUID PK, `restaurant_id` UUID FK, `customer_id` UUID FK nullable, `customer_name`, `customer_phone`, `items` JSONB, `total_price` INT, `status` TEXT (`pending`,`confirmed`,`preparing`,`ready`,`completed`,`delivered`,`cancelled`), `voucher_code`, `discount_amount` INT, `order_type` TEXT (`reservation`,`paid_order`), `payment_status` TEXT (`not_required`,`pending`,`paid`,`failed`,`refunded`), `payment_id` TEXT, `payment_method` TEXT, `payment_amount` INT, `payment_at`, `manual_payment_phone`, `confirmed_at`, `ready_at`, `cancelled_at`, `delivered_at`.

#### `order_items`
Legacy — kept for compatibility with the early prototype; current code reads `orders.items` JSONB.

### 4.4 Events

#### `events`
`id` UUID PK, `title`, `description`, `date` DATE, `time` TIME, `venue`, `city`, `neighborhood`, `category` TEXT, `price` INT, `cover_photo`, `whatsapp`, `organizer_name`, `organizer_id` UUID FK → customers, `is_active` BOOL, `auto_approved` BOOL, `commission_rate` NUMERIC(5,4) default 0.10, `commission_amount` INT, `lat`, `lng`, `payment_enabled` BOOL, `ticket_price` INT, `max_tickets` INT, `tickets_sold` INT, `event_status` TEXT (`upcoming`,`ongoing`,`completed`,`cancelled`), `requires_confirmation` BOOL, `reservations_open` BOOL.

#### `event_reservations`
`id` UUID PK, `event_id`, `customer_id` nullable, `customer_name`, `customer_phone`, `quantity` INT, `total_price` INT, `commission_amount` INT, `payment_status` TEXT (`not_required`,`pending`,`paid`,`failed`), `payment_id`, `payment_method`, `reservation_status` TEXT (`pending`,`confirmed`,`cancelled`,`attended`,`rejected`), `tier_id` UUID FK nullable, `tier_name` TEXT, `tier_price` INT.

#### `event_ticket_tiers`
`id` UUID PK, `event_id`, `name`, `name_en`, `price` INT, `max_quantity` INT (0=unlimited), `sold_count` INT, `sort_order` INT, `is_active` BOOL, `sales_start`, `sales_end`, `description`.

#### `event_likes`
`id`, `event_id`, `customer_id`. UNIQUE (`event_id`,`customer_id`).

#### `event_comments`
`id`, `event_id`, `customer_id`, `nickname` (snapshot at post time), `body` TEXT, `is_hidden` BOOL.

#### `event_subscriptions`
`id`, `customer_id`, `city`, `categories` TEXT[], `is_active` BOOL, `unsubscribed_at`. UNIQUE (`customer_id`,`city`).

### 4.5 Vouchers

#### `vouchers`
`id`, `code` TEXT UNIQUE, `discount_type` TEXT (`percent`,`fixed`), `discount_value` NUMERIC, `min_order` INT, `max_uses` INT nullable, `uses_count` INT, `expires_at`, `is_active` BOOL, `city` TEXT nullable, `restaurant_id` UUID nullable.

#### `customer_vouchers`
`id`, `customer_id`, `voucher_id`, `claimed_at`, `used_at`. UNIQUE (`customer_id`,`voucher_id`).

### 4.6 Broadcasts

#### `broadcasts`
`id`, `sender_id`, `sender_type` (`publisher`,`restaurant`), `restaurant_id` nullable, `title`, `message` (≤1000), `target_city`, `target_categories` TEXT[], `recipient_count` INT, `cost` INT, `payment_status`, `payment_id`, `status` (`draft`,`paid`,`sending`,`sent`,`failed`), `sent_at`.

#### `broadcast_pricing`
`id`, `price_per_recipient` INT (default 50), `min_charge` INT (default 1000), `max_message_length` INT (default 1000), `is_active` BOOL.

### 4.7 Promotions

#### `promotions`
`id`, `promoter_id`, `target_type` (`restaurant`,`event`), `target_id`, `placement` (`top_list`,`feed_card`,`banner`), `city`, `start_date`, `end_date`, `daily_budget` INT nullable, `total_budget` INT, `amount_spent` INT, `impressions` INT, `clicks` INT, `payment_status`, `payment_id`, `status` (`draft`,`pending_review`,`active`,`paused`,`completed`,`rejected`), `reviewed_by`, `rejection_reason`.

#### `promotion_pricing`
`id`, `placement`, `price_per_day` INT, `min_duration_days` INT, `max_duration_days` INT, `is_active` BOOL.

### 4.8 Moderation + audit

#### `reports`
`id`, `target_type`, `target_id`, `reported_by`, `reason` TEXT, `body` TEXT, `status` (`open`,`reviewing`,`resolved`,`dismissed`), `resolved_by`, `resolved_at`.

#### `audit_log`
`id`, `action` TEXT (~70 distinct values), `target_type`, `target_id`, `performed_by`, `performed_by_type`, `previous_data` JSONB, `metadata` JSONB, `created_at`.

---

## 5. Environment variables

| Var | Required | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | yes | Public — read-only anon access |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | yes | Public |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Server-only, bypasses RLS |
| `NEXT_PUBLIC_MAPBOX_TOKEN` | yes | Map tiles |
| `NEXT_PUBLIC_BASE_URL` | yes | Used in WhatsApp deep links + webhook callbacks |
| `JWT_SECRET` | yes | Signs `sm_session` cookies |
| `TWILIO_ACCOUNT_SID` | yes | Twilio REST API account |
| `TWILIO_API_KEY_SID` / `TWILIO_API_KEY_SECRET` | yes | Twilio API Key auth (preferred over auth-token) |
| `TWILIO_WHATSAPP_NUMBER` | yes | `whatsapp:+14155238886` for sandbox |
| `PAWAPAY_API_TOKEN` | yes | Bearer token |
| `PAWAPAY_BASE_URL` | yes | `https://api.sandbox.pawapay.io` or prod |
| `PAWAPAY_ENVIRONMENT` | yes | `sandbox` or `production` (controls webhook signature verification) |

---

## 6. SQL migrations — run order

All in `supabase-*.sql`. Run in order; each is idempotent and safe to re-run.

1. `supabase-setup.sql` — initial schema (customers, restaurants, menu_items, orders, vouchers, customer_vouchers, verification_codes)
2. `supabase-update.sql` — early shape tweaks
3. `supabase-events.sql` — events + event_likes + event_comments
4. `supabase-vouchers.sql` + `supabase-vouchers-system.sql` — voucher fields, customer_vouchers, restaurant-scoped codes
5. `supabase-vendor-signup.sql` — `is_active` flag, `cuisine_type`, `neighborhood`, `owner_name`
6. `supabase-whatsapp-onboarding.sql` — `signup_sessions`
7. `supabase-menu-images.sql` — `menu_items.photo_url`, daily-special flag
8. `supabase-restaurant-photos.sql` — `restaurants.image_url`
9. `supabase-account-system.sql` — `admin_users`, customer status/suspend/delete columns, reports table
10. `supabase-team-invitations.sql` — `restaurant_team`, `team_invitations`, partial unique index
11. `supabase-audit-log.sql` — `audit_log` + indexes
12. `supabase-reviews.sql` — `restaurant_ratings`
13. `supabase-payments.sql` — `payment_*` columns on orders + restaurants
14. `supabase-manual-payment.sql` — `manual_payment_phone` column
15. `supabase-momo-phone.sql` — `customers.momo_phone`
16. `supabase-event-reservations.sql` — `event_reservations`, event ticketing columns, `event_status`
17. `supabase-event-publisher-light.sql` — customer trust counters, event commission
18. `supabase-orders-cancelled-status.sql` — adds `cancelled` to orders CHECK
19. `supabase-orders-delivered-status.sql` — adds `delivered`
20. `supabase-opening-hours.sql` — `restaurant_hours`, timezone, manual_override
21. `supabase-prep-time.sql` — `prep_time_min/max`, `confirmed_at`, `ready_at`
22. `supabase-optimization.sql` — composite indexes for hot-path queries
23. `supabase-kids-events.sql` — Enfants category seeds
24. `supabase-subscriptions.sql` — `event_subscriptions`, `broadcasts`, `broadcast_pricing`, `customers.broadcast_blocked`
25. `supabase-promotions.sql` — `promotions`, `promotion_pricing`
26. `supabase-event-capacity.sql` — `events.requires_confirmation` + `reservations_open`, widen `reservation_status` CHECK
27. `supabase-rename-categories.sql` — Music→Concert / Food→Gastronomie / Art→Culture / Nightlife→Festival / BT|Club→BT/Club
28. `supabase-ticket-tiers.sql` — `event_ticket_tiers`, reservation tier_* denormalisation

---

## 7. Key libraries

- `lib/audit.ts` — `writeAudit({ action, targetType, targetId, performedBy, performedByType, previousData, metadata })`. Non-throwing.
- `lib/auth.ts` — JWT sign/verify + cookie helpers.
- `lib/categoryLabels.ts` — FR/EN event-category labels + bilingual variant for WhatsApp.
- `lib/clientVersion.ts` — bump `CLIENT_VERSION` to invalidate stale `tn_*` localStorage on next page load.
- `lib/countriesData.ts` — ~190 countries with flag emoji, dial code, FR + EN names.
- `lib/openingHours.ts` — schedule formatter + timezone-aware open/closed computer.
- `lib/pawapay.ts` — REST client + MNO detection + webhook signature verification.
- `lib/payments-notify.ts` — fan-out helpers fired by the webhook (`notifyPaidOrder`, `notifyPaidReservation`).
- `lib/phone.ts` — `normalizePhone()` (single source of truth for phone normalization).
- `lib/phoneValidation.ts` — country tier resolution, sorting, validation, search.
- `lib/prepTime.ts` — `validatePrepTime` + `formatPrepTime` (clamp 5–120 min).
- `lib/promoTracking.ts` — impressions + click fire-and-forget with sessionStorage dedupe.
- `lib/promotions.ts` — eligibility, pricing, `arrangePromoted()` (top_list pin + feed_card injection).
- `lib/ratings.ts` — rating + tag constants.
- `lib/reports.ts` — report-flow helpers.
- `lib/subscriptions.ts` — eligibility, pricing, `findMatchingSubscribers`, `notifyEventSubscribers`, `fanoutBatched`.
- `lib/tiers.ts` — `tierAvailability()`, `summarisePrice()`, fetchers.
- `lib/translations.ts` — `dict[locale][key]`, ~1000 strings × 2 languages.
- `lib/vouchers.ts` — discount math (`isPercentDiscount`, `assignWelcomeVoucher`).
- `lib/whatsapp.ts` — `sendWhatsApp(to, body)` + notification templates for orders.
- `lib/whatsapp/ordering.ts` — WhatsApp customer-ordering session machine, event commands, reservation flows.

---

## 8. Security status

### 8.1 Implemented
- JWT cookies are `httpOnly`, `sameSite='lax'`, `secure` in prod.
- Service-role Supabase key never reaches the browser — every mutation routes through an API route.
- Every table that holds anything sensitive enforces `service_role_only` RLS so a leaked anon key can't read or write.
- Admin passwords are bcrypt-hashed (10 rounds).
- WhatsApp OTP codes are single-use, 6-digit, 10-minute TTL, max 5 attempts.
- PawaPay webhook verifies the RFC-9421 `Content-Digest` header in production.
- Cache-Control headers prevent stale HTML serving a deploy that has been rolled (HTML `no-cache, must-revalidate`; `/api/*` `no-store`).
- Phone normalisation centralised (`lib/phone.ts`) so injection-style payloads can't sneak through inconsistent parsers.

### 8.2 TODO (tracked in `ROADMAP.md`)
- **Rate-limiting** on `/api/auth/send-code` and `/api/payments/initiate` — currently unprotected against floods.
- **CSRF tokens** — Lax-cookie + same-origin-only API routes provide partial protection but explicit tokens haven't been added.
- **Audit-log UI** — read access is via direct SQL, no web surface for support.
- **Per-IP / per-phone rate-limits** on report submission (`POST /api/reports`).
- **Webhook signature verification** is enabled in production but the sandbox path bypasses — production migration plan should re-test this.
- **Bcrypt rounds** at 10 — consider 12 once we hit auth scale.
- **Secret rotation** — `JWT_SECRET` rotation hasn't been exercised; rotating today invalidates every session in flight.
- **PII access logs** — DB-side audit on PII reads isn't enabled.

---

## 9. Deployment

- Vercel project linked to `babnitch/streetmenu`. PR → preview URL; merge to `main` → prod.
- Production domain: `streetmenu.vercel.app` (custom domain TBD).
- Env vars set in Vercel dashboard (Project Settings → Environment Variables).
- Supabase project is the same across all Vercel envs (no per-env DB). One day we may add a staging Supabase project for safer migration testing.
- `vercel.json` declares one cron: daily 02:00 UTC `POST /api/admin/cleanup-expired` (purges stale `signup_sessions`, expired `verification_codes`, expired `team_invitations`).
- `vercel.json` also mirrors `next.config.mjs` cache headers as a defense-in-depth measure.
- Twilio sandbox in dev; users must `join <keyword>` to opt in. Production uses a paid sender + business-initiated WhatsApp template (still to be approved).
- PawaPay sandbox keys + sandbox base URL while testing; production keys live in Vercel prod env only.
