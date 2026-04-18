# WhatsApp ordering — design

**Status:** accepted (2026-04-18)
**Scope:** customer ordering via WhatsApp, vendor notifications and state transitions, customer-web order tracking.
**Out of scope (deferred):** voucher application. `orders.voucher_code` / `discount_amount` columns stay but default null/0.

## Goals

1. A registered customer can place an order end-to-end on WhatsApp.
2. The vendor (owner + all managers) is notified of new orders and can accept / mark ready / cancel them with short replies.
3. Customers see status updates on WhatsApp and in `/account`.
4. All lifecycle events land in `audit_log`.

## Non-goals

- Vouchers / discounts (next PR).
- Delivery logistics, couriers, payments.
- Order editing after submission.
- Order statuses `preparing` and `completed` — out of scope for the commands the vendor can send from WhatsApp; the columns remain, they just aren't set by this flow.

## Architecture

### New files

- `lib/whatsapp/ordering.ts` — pure functions. Exports:
  - `handleOrderingSession(from, phone, body, cmd, session)` — continues an in-progress ordering session (steps 1–3).
  - `handleOrderCommand(from, phone, body, cmd, customer)` — handles `commander` / `mes commandes` from a registered customer with no active session.
  - `handleVendorOrderAction(from, phone, body, restaurant)` — handles `ok XXXX` / `pret XXXX` / `annuler XXXX` from a vendor.
  - Internal helpers: `parseOrder`, `listRestaurantsForCity`, `buildMenuMessage`, `notifyVendors`, `findOrderByLast4`.
- `supabase-orders-cancelled-status.sql` — one-shot migration to widen `orders_status_chk` to include `'cancelled'`.

### Modified files

- `app/api/whatsapp/incoming/route.ts`
  - `handleSession`: add `user_type === 'ordering'` branch → delegate to `handleOrderingSession`.
  - `handleCustomer`: add `commander` / `order` / `commande` and `mes commandes` / `my orders` intents; rewrite the help message.
  - `handleVendor`: add vendor order-action regex matches before the unknown-command fallthrough.
  - Top-level dispatcher: if a customer has an active ordering session and sends a command not recognized by `handleOrderingSession` as order input, reply with a short "continue or cancel?" nudge instead of falling through to customer-help.
- `lib/whatsapp.ts` — add `notifyCustomerOrderCancelled`; update `notifyVendorNewOrder` to include `#<last4>` and the `ok XXXX` / `annuler XXXX` action hints.
- `lib/audit.ts` — widen `AuditEntry.targetType` union to include `'order'`.
- `app/account/page.tsx` — each order card becomes click-to-expand with items list, qty × name — price, total, `#<last4>`, restaurant name. Status badge uses a color map.

## Ordering state machine

`signup_sessions` row with:
- `phone` — customer's WhatsApp number
- `user_type` = `'ordering'`
- `step` ∈ {1, 2, 3}
- `data` JSONB — see shape below
- `expires_at` — now + 30 minutes

`data` shape evolves per step:

| After step | `data` content |
|---|---|
| 1 → 2 | `{ restaurant_id, restaurant_name, menu: [{ menu_item_id, name, price }] }` |
| 2 → 3 | `data` above + `items: [{ menu_item_id, name, price, quantity }], total` |

Storing the menu snapshot at step 1 → 2 lets step 3 price the order against what the customer actually saw, even if the vendor edits the menu mid-flow.

| Step | Waiting for | On success | On error |
|---|---|---|---|
| 1 | restaurant number (1…N) | store id + name + menu snapshot, go to 2, send menu | "Numéro invalide, envoyez 1-N" |
| 2 | order syntax | parse → store `items[]` + `total`, go to 3, send summary | "Format non compris, ex: 1 x2, 3 x1" |
| 3 | `oui` / `non` | `oui` → insert order + items + audit + fan-out, clear session; `non` → clear session | "Envoyez 'oui' pour confirmer ou 'non' pour annuler" |

`annuler` / `cancel` at any step clears the session (already wired at the route's top level).

## Order parser

Input is comma-split; each token is trimmed and matched against, in order:

1. **Number-based**: `/^(\d+)\s*[x×](\d+)$/i` → `(itemNumber, qty)`. `itemNumber` indexes into the step-1 menu snapshot.
2. **Name-based**: `/^(\d+)\s+(.+)$/` → `(qty, name)`. Name resolved via existing `findMenuItem` helper (exact → partial ilike), then matched against the menu snapshot to make sure the item is still available.

Validation per token:
- `qty` in [1, 99]; else "Quantité invalide / Invalid quantity".
- item must exist in the menu snapshot and be `is_available=true`; else "Plat introuvable / Item not found" or "X indisponible / unavailable".

Empty parse → "Commande vide / Empty order". Duplicates merged (sum the quantities).

## Restaurant list (step 1)

```sql
SELECT id, name, cuisine_type
FROM restaurants
WHERE is_active = true
  AND status IN ('active', 'approved')
  AND deleted_at IS NULL
  AND city = :customer_city
ORDER BY name
LIMIT 20;
```

Both `'active'` and `'approved'` are treated as publicly visible — the DB holds rows with `'approved'` in addition to the CHECK constraint's documented set.

If 0 rows in customer's city, re-query without the `city` filter and prefix the reply with *"Aucun restaurant à {city}. Voici tous les restaurants / No restaurants in {city}. Here are all:"*.

## Vendor fan-out on order creation

Recipients = deduped set of:
- `restaurants.whatsapp` (owner direct; always)
- Phone numbers from `restaurant_team JOIN customers ON restaurant_team.customer_id = customers.id` where `restaurant_id = X` AND `role IN ('owner','manager')` AND `restaurant_team.status = 'active'`.

Sent via `Promise.allSettled` — one failed Twilio call doesn't block the others. Failures logged to stderr.

Vendor message format:
```
🔔 *NOUVELLE COMMANDE / NEW ORDER!*
━━━━━━━━━━━━━━━━━━

🧾 Commande #<last4>
👤 <customer_name>
📱 <customer_phone>

🍽️ *Articles / Items:*
  • 2× Ndolé (5,000 FCFA)
  • 1× Eru (2,000 FCFA)

💰 *Total: 7,000 FCFA*

━━━━━━━━━━━━━━━━━━
Répondez 'ok <last4>' pour confirmer / Reply 'ok <last4>' to confirm
Répondez 'annuler <last4>' pour annuler / Reply 'cancel <last4>' to cancel
```

## Vendor actions

Regexes matched in `handleVendor` before the "unknown command" fallthrough:

- `/^ok\s+([0-9a-f]{4})$/i` → status ∈ {pending, confirmed} → `'confirmed'`; customer gets confirmed notification.
- `/^(pret|ready)\s+([0-9a-f]{4})$/i` → status ∈ {confirmed, preparing} → `'ready'`; customer gets ready notification.
- `/^(annuler|cancel)\s+([0-9a-f]{4})$/i` → any non-terminal status → `'cancelled'`; customer gets cancellation notification.

Order lookup is scoped to the vendor's `restaurant_id` AND `id::text LIKE '%' || :last4`. If 0 or >1 match, reply "Commande #XXXX introuvable / Order not found".

Each success writes audit (`order_confirmed` / `order_ready` / `order_cancelled`, `target_type='order'`, `performed_by=restaurant.id`, `performed_by_type='vendor'`).

## Customer `/account` orders tab

- Each order row becomes a clickable card with a chevron.
- Expanded view shows:
  - `#<last4>` (monospace)
  - Bilingual status badge with color (pending=amber, confirmed=blue, preparing=indigo, ready=green, completed=gray, cancelled=red)
  - Items list: `<qty>× <name> — <price> FCFA` per line
  - `Total: <total> FCFA`
- `loadCustomerData` already fetches everything needed; no new API routes.

## Help message (registered customer)

```
👋 Bonjour <name>! / Hello <name>!

📋 Commandes disponibles / Available commands:
🍽️ "commander" → Passer une commande / Place an order
📦 "mes commandes" → Voir vos commandes / View your orders
🏪 "restaurant" → Inscrire votre restaurant / Register restaurant
❓ "aide" → Ce message / This message

🌍 Navigation:
<BASE_URL>   — Parcourir / Browse
<BASE_URL>/account — Mon compte / My account
```

## Audit events

- `order_created` — `target_type='order'`, `performed_by=customer.id`, `performed_by_type='customer'`, `metadata={restaurant_id, total_price, item_count}`
- `order_confirmed` / `order_ready` / `order_cancelled` — `target_type='order'`, `performed_by=restaurant.id`, `performed_by_type='vendor'`

## Migration

`supabase-orders-cancelled-status.sql` drops the existing `orders_status_chk` constraint and recreates it as:

```sql
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_chk;
ALTER TABLE orders ADD CONSTRAINT orders_status_chk
  CHECK (status IN ('pending','confirmed','preparing','ready','completed','cancelled'));
```

Idempotent; run once in Supabase SQL editor before the feature ships.

## Test plan

Local curl simulating Twilio's form-encoded webhook (shape matches the existing route at `app/api/whatsapp/incoming/route.ts:106-114`).

1. Unregistered phone sends `commander` → bot starts customer signup (name → city).
2. Registered customer sends `commander` → list of restaurants in city → pick `1` → menu → `1 x2, 3 x1` → summary → `oui` → order row created, vendor notified.
3. Vendor phone sends `ok <last4>` → order status = `confirmed`; customer notified.
4. Vendor phone sends `pret <last4>` → `ready`; customer notified.
5. Vendor phone sends `annuler <last4>` → `cancelled`; customer notified (requires migration applied).
6. Customer phone sends `mes commandes` → last 5 orders with bilingual status.
7. Browser: `/account` orders tab — expand a card → items + total visible.

## Non-obvious decisions

- **Menu snapshot stored in session** at step 1→2 so step 3 prices against what the customer saw. Mid-flow menu edits by the vendor don't mutate an in-flight order.
- **Fan-out uses `Promise.allSettled`** rather than sequential awaits so a single vendor-phone Twilio failure doesn't prevent the customer from receiving the order-confirmation reply.
- **`'approved'` accepted alongside `'active'`** for restaurant visibility because production data contains rows with that status — the CHECK constraint documented `'active'` only, but the table has `'approved'` rows. Spec and implementation match the live data.
- **`signup_sessions` key is `phone`** → ordering conflicts with signup/vendor-registration. Handled by the top-level nudge "you have an order in progress, continue or cancel?".
