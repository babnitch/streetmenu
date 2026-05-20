# Tchop & Ndjoka — Functional Specification (v4.0)

**Last updated:** 2026-05-20
**Status:** MVP live — pre-launch
**Live URL:** https://streetmenu.vercel.app
**Repo:** github.com/babnitch/streetmenu

This document is the *what* of the product. For the *how* (schema, routes, env, deploy) see `TECHNICAL-REQUIREMENTS.md`. For the timeline / phases see `ROADMAP.md`. For unbuilt feature ideas see `IDEAS-BACKLOG.md`.

---

## 1. Cities & countries

| City | Country | Dial code | PawaPay routing |
|---|---|---|---|
| Yaoundé | 🇨🇲 Cameroon | +237 | MTN MoMo, Orange CMR |
| Abidjan | 🇨🇮 Côte d'Ivoire | +225 | MTN MoMo, Orange CIV, Moov CIV |
| Dakar | 🇸🇳 Senegal | +221 | Orange SEN, Free SEN |
| Lomé | 🇹🇬 Togo | +228 | — *(MoMo not yet routed)* |
| Cotonou (Benin) | 🇧🇯 Benin | +229 | MTN MoMo, Moov BEN |

The phone-number input accepts **all ~190 ISO 3166-1 countries** with bilingual names (FR/EN) for tourists/diaspora; only the 5 platform countries above can use MoMo payments. Cities are seeded; new cities require code + DB change.

---

## 2. User types

| Type | Auth | Where they live | Source of truth |
|---|---|---|---|
| **Customer (anon)** | none | `/`, `/events`, `/restaurant/[id]`, `/events/[id]` | session = null |
| **Customer (logged in)** | WhatsApp OTP via Twilio | `/account`, all customer pages | `customers` row, JWT cookie `sm_session` |
| **Restaurant owner** | same as customer | `/dashboard`, `/account` | `restaurants.customer_id = customer.id` |
| **Restaurant manager** | same as customer | `/dashboard` (write subset) | `restaurant_team.role = 'manager'` |
| **Restaurant staff** | same as customer | `/dashboard` (read-only orders) | `restaurant_team.role = 'staff'` |
| **Event publisher** | same as customer | `/events/submit`, `/account` (events tab) | `events.organizer_id = customer.id` + trust gate |
| **Verified publisher** | same as customer | auto-approved future events | `customers.event_auto_approve = true` |
| **Moderator** | email + bcrypt password | `/admin` (limited tabs) | `admin_users.role = 'moderator'` |
| **Admin** | email + bcrypt password | `/admin` (most tabs) | `admin_users.role = 'admin'` |
| **Super admin** | email + bcrypt password | `/admin` (all tabs incl. platform team) | `admin_users.role = 'super_admin'` |

Authentication details:
- Customers sign in by phone — a 6-digit code is sent to their WhatsApp via Twilio; the code lives in `verification_codes` with a 10-minute TTL. Verifying issues a JWT cookie (`sm_session`, 24h by default / 30d with "Remember me").
- Admins sign in with email + password on the same `/account` page (Team tab). Passwords are bcrypt-hashed in `admin_users.password_hash`.
- Same `sm_session` JWT used for both — `role` claim disambiguates customer vs admin paths.

---

## 3. Customer features

### 3.1 Discovery (`/`)
- Restaurant list filtered by **current city** (TopNav dropdown, persisted in `tn_selected_city` localStorage).
- Mobile-first card grid; desktop adds a left-rail sidebar.
- Each card: name, neighborhood + city, prep time chip (`20-35 min`), cuisine pill, ⭐ rating + count, 🟢/🔴 open status.
- Toggle "Open now" filter (`?open=1` deep-linkable).
- Search input (`?q=` deep-linkable) matches name / cuisine / neighborhood.
- Fullscreen map view (Mapbox) — pin colour mirrors open status; tap pin → sidebar with the restaurant card.
- **Promoted restaurants** (paid native ads, see §6.5) are pinned at the top + injected every 5th position with a subtle "Sponsorisé / Sponsored" line.
- "Pending orders" banner for vendors browsing the home page (links to `/dashboard`).

### 3.2 Restaurant detail (`/restaurant/[id]`)
- Hero photo (or T initial gradient), open status chip, prep time card, opening hours panel, ratings + rate-it CTA.
- Daily specials section (top), then menu grouped by category with sticky category tabs when ≥2 categories.
- Each menu item: photo, name, description, price, daily-special chip; add-to-cart on tap.
- Floating cart bar with item count + total.
- Banner ad placement (`<BannerAd />`) — one paid promotion between sections; nothing rendered when no active banner promo for the city.
- Report button (`<ReportButton />`) — flags abuse to admin review queue.
- Share link copies a pre-filled WhatsApp message.

### 3.3 Cart + checkout (`/order`)
- Cart state lives in `cartContext` (localStorage-backed) and is scoped to one restaurant at a time — adding from another restaurant prompts to clear.
- Auto-fills name + phone from the JWT session; logged-out users enter both.
- Voucher input — typing a code (or picking from "My vouchers") applies the discount client-side; server re-validates at submission.
- Payment block (only when `restaurants.payment_enabled=true`):
  - PhoneInput defaults to the restaurant's country.
  - Bilingual disclaimer "Mobile Money disponible pour les numéros africains uniquement".
  - MNO preview chip (MTN / Orange / Moov / Free) detected client-side.
- Two paths after submit:
  - **Pay-at-door / reservation** → row inserted with `payment_status='not_required'`. Customer + vendor WhatsApp ack immediately.
  - **PawaPay deposit** → row inserted as `payment_status='pending'`; client polls `/api/payments/status/[depositId]` (5s interval, 90s timeout); webhook flips to `paid` and notifies both sides.
- Closed-restaurant gate: ordering blocked unless `allow_orders_when_closed=true`.

### 3.4 Customer account (`/account`)
- Tabs (bilingual labels): Orders (default), Vouchers, Events (organizer-only when applicable), Profile, Restaurant (vendors), Team (owners).
- **Orders tab** — list of own orders with status timeline, voucher applied, payment badge (`<PaymentBadge />`), and a "Pay now" button when status is `confirmed` but unpaid.
- **Vouchers tab** — claimed vouchers + a "Claim a code" input. Welcome banner shown after first sign-in with the `BIENVENUE` 10%-off code.
- **Events tab** — only when the customer has organized at least one event. Per-event drill-down shows reservation list, stats, tiers (`<EventTiersPanel />`), settings (open/close, manual approval, capacity).
- **Profile tab** — name, phone (read-only), city, nickname (used to sign comments — 7-day change cooldown), language toggle, mode toggle (client/restaurant), Notifications panel, Broadcast panel (eligible only), Promote panel (eligible only), Self-suspend / Delete account.

### 3.5 Event discovery + reservation
- `/events` — city-filtered list, category pills (Concert, Festival, BT/Club, Sport, Culture, Gastronomie, Enfants, Business, Autre), event cards with date / venue / price range / closed-reservations badge / Sponsorisé label.
- Event subscriptions: customers can subscribe to a city (+ optional category whitelist) to receive WhatsApp alerts for new events. Subscribe modal at top of `/events`; account-page panel manages active subscriptions per city.
- `/events/[id]` — hero, description, organizer info, share + report buttons, social panel (likes + comments), and:
  - **Single-price events**: quantity stepper + "Réserver" / "Réserver et payer" CTA.
  - **Multi-tier events**: tier cards (name, price, description, X/Y remaining) with per-tier `−/+` quantity stepper; bottom CTA shows total or "Sélectionnez un tarif".
  - **Closed events**: 🔒 banner replaces the CTA when `reservations_open=false`.
- Reservation flow: free + pay-at-door uses `/api/events/[id]/reserve`; paid uses `/api/events/[id]/pay` (one tier per deposit). When `requires_confirmation=true`, the row lands as `pending` and the organizer must confirm or reject — the customer sees `⏳ pending` until then.
- Event ticketing: confirmed reservations get a unique reservation ID surface; attendance is marked by the organizer in their dashboard.

### 3.6 Ratings
- `/restaurant/[id]#rate` → rating panel: 1-5 stars + optional tag chips (food / service / value / cleanliness) + optional comment.
- One rating per customer per restaurant, editable. Ratings live in `restaurant_ratings`; aggregate via `/api/restaurants/[id]/rating`; bulk-loaded on the home grid via `/api/restaurants/ratings-summary?ids=…`.
- Customers who placed at least one `delivered` order at the restaurant can rate — gate enforced server-side.

### 3.7 Vouchers
- Customer surfaces:
  - Welcome voucher (`BIENVENUE` — 10% off, city-scoped) auto-assigned on first signup.
  - Claim a code from the Vouchers tab or WhatsApp (`bon CODE`).
  - "My vouchers" list shows code, type (% or fixed), discount, min-order, expiry, applicable restaurant (if scoped).
  - Apply at checkout: dropdown picker or paste — server validates `is_active`, `expires_at`, `min_order`, `customer_vouchers.used_at IS NULL`, restaurant scope.
- One voucher per order. Discount column persisted to `orders.discount_amount` so admin reports stay accurate even after voucher edits.

### 3.8 Reporting (`<ReportButton />`)
- Available on restaurants, events, menu items, vouchers (anywhere abuse can happen).
- Pre-filled reason dropdown + free-text. Anonymous if logged out.
- Lands in admin Reports tab; admin can mark resolved or escalate (suspend the target).

### 3.9 Notifications & broadcasts (customer side)
- Subscribe to event alerts by city + categories (see §3.5).
- Receive WhatsApp broadcasts from verified publishers / approved restaurants who paid.
- All notifications include a tail "Send 'desabonner' to stop." — managed centrally so the unsubscribe surface stays consistent.

---

## 4. Vendor features (restaurant ops)

### 4.1 Mode switcher (`<ModeToggle />`)
- Anyone with a `restaurant_team` row sees a Client ⇄ Restaurant toggle on `/account`. Choice persists in `tn_mode` localStorage.
- Switching to Restaurant pushes to `/dashboard` (from `/account`). Restaurant mode swaps the BottomNav tabs to vendor surfaces (📦 Orders / 🍽️ Menu / 🎫 Vouchers / 👤 Account) and the TopNav nav cluster to the dashboard tabs.
- The Restaurants and Events links are *always visible* in the TopNav so vendors can jump back to the public side without flipping modes first.

### 4.2 Dashboard (`/dashboard`)
Tab strip (context-driven via `modeContext.dashboardTab`):
- **Orders** — pending + confirmed + preparing + ready columns. Each card: customer name + phone (tap-to-WhatsApp), items, total, time elapsed, payment badge, manual mark-paid (cash/MTN/Orange/Moov), status transitions (`ok` → `preparing` → `pret` → `recupere`). Bell + pending-count badge on the tab icon. Soft real-time via Supabase subscription on `orders`.
- **Menu** — list grouped by category; add / edit / delete items with photo upload, daily-special toggle, in/out-of-stock toggle.
- **Vouchers** — create restaurant-scoped vouchers (% or fixed amount, min order, expiry, max uses). Validate codes brought in by customers.
- **Settings** — opening hours editor (week + per-day open/close, closed-day toggle, overnight windows), prep time range, image, payment toggle + payout phone, allow-orders-when-closed flag, suspend self.

### 4.3 Opening hours + manual override
- Per restaurant: 7 weekday rows in `restaurant_hours`. Overnight windows supported (e.g. close at 02:00 = 26:00 logical).
- Server-computed open status via `/api/restaurants/open-status?ids=…` (60s edge cache). Combines the schedule with `manual_override` (`'open' | 'closed' | null`) and the city's IANA timezone (`Africa/Douala` / `Africa/Abidjan` / `Africa/Dakar` / `Africa/Lome`).
- Hooked into home cards, map pins, restaurant detail, dashboard.

### 4.4 Prep time
- Per restaurant: `prep_time_min` + `prep_time_max` (minutes, default 20-35). Rendered everywhere as "X-Y min" — home cards, restaurant detail, order tracker, vendor WhatsApp menu.
- Owner-only edit; staff sees current value.

### 4.5 Promotions (paid native ads)
- Restaurant owners + verified event publishers can pay PawaPay to feature their listing in three placements:
  - `top_list` — pinned at top of `/` or `/events` for a city, 2,000 FCFA/day.
  - `feed_card` — injected every Nth card in the list, 1,000 FCFA/day.
  - `banner` — single banner on the restaurant-detail page, 500 FCFA/day.
- Per-day billing, full amount upfront. After payment, the promotion enters `pending_review` until admin approves it.
- Impressions counted via IntersectionObserver (1h sessionStorage dedupe); clicks counted on link tap. Both for analytics — they don't affect billing.
- `<PromotePanel />` on `/account` profile = composer + history with CTR + pause/resume/cancel.

### 4.6 Broadcasts (paid WhatsApp blasts)
- Verified publishers + approved restaurant owners can pay to send a message to all event-notification subscribers in a city (optionally filtered by category).
- Pricing: 50 FCFA per recipient, 1,000 FCFA minimum (admin-editable).
- Rate-limit: 1 broadcast per sender per 24h.
- Admin can block a sender (`customers.broadcast_blocked`).

### 4.7 Team
- Owner can invite by phone (`team_invitations` row + WhatsApp invite). Invitee replies `accepter` / `refuser`.
- Roles:
  - **Owner** — full control, can edit menu / hours / payment / team, suspend the restaurant.
  - **Manager** — menu + orders + vouchers + open/close, no team management.
  - **Staff** — view orders + advance their state. No menu, no settings.
- Team panel (`/account` → Team) lists active members + pending invitations; cancel invitation, remove member.

### 4.8 Ratings (vendor side)
- Reviews appear on the restaurant page + dashboard. Vendor sees stars + count + per-tag breakdown.
- Vendor can flag abusive reviews via `<ReportButton />`; admin resolves.

### 4.9 Onboarding
- `/join` — public 1-page form for restaurant signup (name, owner name, WhatsApp phone, city, neighborhood, cuisine, photo). Inserts an inactive restaurant; admin reviews + approves.
- Mid-flow signup is also available over WhatsApp via the `restaurant` keyword (see §7).

---

## 5. Event publisher features

### 5.1 Submit (`/events/submit`)
Login-required. Form fields:
- Title, description, date, time, venue, city, neighborhood, category (see category list in §3.5).
- Cover photo upload.
- Capacity, single-price OR multi-tier toggle.
- Multi-tier mode: dynamic list of tier rows (name FR, name EN optional, price, max_quantity, description) + three presets (🎉 Standard / 👶 Famille / ⭐ VIP).
- Online payment toggle (PawaPay) — only available when `ticket_price > 0`.
- Manual approval toggle — each reservation stays `pending` until organizer confirms.
- WhatsApp phone for the organizer.

### 5.2 Trust gate (auto-approve)
- `customers.events_submitted_count` and `events_approved_count` track lifetime metrics.
- After 3 approved events the customer's `event_auto_approve=true` flag flips on; their next submissions skip admin review.
- Admin can revoke auto-approve via `POST /api/admin/events/revoke-auto-approve/[customerId]`.

### 5.3 Organizer dashboard (`/account` → Mes événements)
- List of organized events with reservation count, tickets sold, gross revenue, 10% commission, net revenue, pending-approval count.
- Per-event drill-down: stats card, `<EventTiersPanel />` (CRUD on tiers), settings card (open/close toggle, manual-approval toggle, capacity bump), reservation list with filter tabs (All / Pending / Confirmed / Attended) and per-row Confirm / Reject / Mark Attended / Cancel buttons.

### 5.4 Subscriber notifications (auto-fire)
- When an event is approved (manual by admin or auto by trust gate), `notifyEventSubscribers()` fans out a WhatsApp message to every active subscriber in the event's city whose category whitelist matches (or is null = all categories). Rate-limited to 100 sends per event, batched 20/sec.

### 5.5 Commission
- 10% per event reservation, locked in at reservation time (`event_reservations.commission_amount`) so a later rate change doesn't retroactively shift what the organizer owes.
- Surfaced on the organizer's dashboard as Commission + Net Revenue.

---

## 6. Admin features

### 6.1 Roles & permissions

| Tab | super_admin | admin | moderator |
|---|:--:|:--:|:--:|
| Restaurants | ✓ | ✓ | ✓ |
| Orders | ✓ | ✓ | ✓ |
| Events | ✓ | ✓ | ✓ |
| Broadcasts | ✓ | ✓ | ✓ |
| Promotions | ✓ | ✓ | ✓ |
| Reports | ✓ | ✓ | ✓ |
| Vouchers | ✓ | ✓ | — |
| Accounts | ✓ | ✓ | — |
| Platform Team | ✓ | — | — |
| Profile | ✓ | ✓ | ✓ |

### 6.2 Admin dashboard (`/admin` or `/account` while logged in as admin)
- **Restaurants** — list, filter by status, approve / suspend / reactivate / delete (soft), undo-delete, override admin can edit any restaurant row.
- **Orders** — read-only platform-wide order list with filters; cannot mutate per-restaurant state (vendors own that).
- **Events** — pending review queue (approve / reject), approved list with stats (reservations + revenue + commission). Revoke auto-approve.
- **Broadcasts** — list with status filter (All / Pending / Sent / Failed), view message, block sender, edit pricing (per-recipient + min charge + max length), subscription stats per city + category.
- **Promotions** — list with status filter, approve / reject (pending review), pause / resume (active), edit pricing per placement, total revenue card.
- **Reports** — moderation queue.
- **Vouchers** — platform-wide voucher CRUD (non-restaurant-scoped, e.g. `BIENVENUE`).
- **Accounts** — customer search / suspend / delete / release-number (free up a phone after deletion), auto-link orphaned restaurants to customers by phone.
- **Platform Team** — invite / remove other admin_users. Super-admin only.
- **Profile** — edit own admin name + password.

### 6.3 Audit trail
- Every server-side mutation goes through `lib/audit.ts → writeAudit()`. Rows land in `audit_log` with `action`, `target_type` (`customer`, `restaurant`, `order`, `event`, `event_reservation`, `voucher`, `report`, `restaurant_team`, `admin_user`, `promotion`), `target_id`, `performed_by`, `performed_by_type`, `previous_data`, `metadata`, timestamp.
- ~70 audit actions catalogued (signup, login, restaurant_approved, order_status_changed, payment_completed, voucher_consumed, event_reservation_created, reservation_confirmed_by_organizer, broadcast_sent, promotion_paid, tier_created, …).
- Currently no admin UI surfaces the log — viewing is direct SQL only.

---

## 7. WhatsApp commands (Twilio)

The `/api/whatsapp/incoming` route is the single Twilio webhook. It routes by:
1. Active signup_sessions row (multi-step onboarding).
2. Invitation accept/decline keywords.
3. Customer / vendor record lookup.
4. Brand-new phone → starts customer signup.

### 7.1 Customer commands

| Command | Result |
|---|---|
| `aide` / `help` / empty | List of available commands |
| `commander` / `order` | Start an ordering session (pick restaurant → items → checkout) |
| `mes commandes` / `my orders` | Recent orders with status |
| `payer` / `pay` | Retry an unpaid order |
| `mes bons` / `my vouchers` | List claimed vouchers |
| `bon CODE` / `voucher CODE` | Claim a code |
| `evenements` / `events` | Browse upcoming events |
| `reserver XXXX` / `book XXXX` | Reserve an event by short code |
| `mes reservations` / `my reservations` | List own reservations |
| `annuler reservation N` | Cancel reservation by list position |
| `noter` / `rate` | Rate the last delivered-order restaurant |
| `signaler` / `report` | Open report flow |
| `abonner` / `subscribe` | Subscribe to event alerts in your city |
| `abonner concerts enfants` | Subscribe to specific categories |
| `abonner tout` / `subscribe all` | Subscribe to all categories |
| `desabonner` / `unsubscribe` | Unsubscribe (all cities) |
| `mes abonnements` / `my subscriptions` | List active subscriptions |
| `diffuser` / `broadcast` | Redirect to web compose UI |
| `promouvoir` / `promote` | Redirect to web compose UI |
| `publier` / `publish` | Deep-link to `/events/submit` |
| `restaurant` / `inscription` | Start vendor signup |
| `accepter` / `refuser` | Accept / decline a team invitation |
| `annuler` / `cancel` | Cancel the active session |

### 7.2 Vendor commands (active inside an approved restaurant context)

| Command | Result |
|---|---|
| `aide` / `help` | Vendor command list (role-aware) |
| `menu` | Show current menu items + availability |
| `Nom - Prix` (with photo) | Add a menu item (asks for category) |
| `Nom - Prix - Catégorie` | Add a menu item directly |
| `prix Nom 3000` | Update price |
| `dispo Nom` / `indispo Nom` | Toggle availability |
| `supprimer Nom` / `delete Nom` | Delete a menu item |
| `photo restaurant` | 5-minute window to send a new restaurant photo |
| `commandes` / `orders` | Show pending + confirmed + preparing orders |
| `ok XXXX` | Confirm an order |
| `preparer XXXX` | Start preparing |
| `pret XXXX` | Mark ready for pickup |
| `recupere XXXX` | Mark picked up |
| `annuler XXXX` | Cancel an order |
| `paye XXXX cash` / `mtn 237…` / `orange 237…` | Mark order paid (cash or specific MNO) |
| `horaire` / `hours` | Show schedule + current status |
| `ouvrir` / `fermer` / `auto` | Manual override |
| `temps` / `temps 20 35` | View / set prep time range |
| `equipe` / `team` | List team members |
| `ajouter +237X manager` | Add or invite a team member |
| `inviter +237X staff` | Same as add, biased toward inviting a non-customer |
| `invitations` | List pending invitations |
| `annuler invitation +237X` | Cancel a pending invitation |
| `retirer +237X` | Remove a team member |
| `mes restaurants` / `my restaurants` | Multi-restaurant selector |
| `suspendre` / `reactiver` | Suspend / reactivate own restaurant |

### 7.3 Event-organizer commands

| Command | Result |
|---|---|
| `mes evenements` / `my events` | List own events with reservation count |
| `reservations XXXX` | List reservations for one of your events |
| `confirmer reservation XXXX` / `rejeter reservation XXXX` | Approve / deny a pending reservation by 4-char ID suffix |
| `fermer reservations XXXX` / `ouvrir reservations XXXX` | Toggle the reservations gate on an event |
| `tarifs XXXX` / `tiers XXXX` | List the event's ticket tiers |
| `ajouter tarif XXXX nom prix [max]` | Quick-create a tier (underscores in name → spaces) |

### 7.4 Output guarantees
- All outgoing WhatsApp text is **bilingual French / English** (FR line then EN line, or the two sides of a `/`).
- Each notification ends with an unsubscribe hint when relevant.
- Failures are best-effort — the API still returns 2xx so Twilio doesn't retry.

---

## 8. Payments (PawaPay)

### 8.1 Routing
- `lib/pawapay.ts` exposes `createDeposit`, `checkDepositStatus`, `createPayout`. `detectMNO(phone, country?)` maps E.164 → PawaPay correspondent (e.g. `MTN_MOMO_CMR`, `ORANGE_CIV`, `FREE_SEN`, `MOOV_BEN`).
- Country inferred from the restaurant city via `countryFromCity()`. Togo (Lomé) has no PawaPay correspondent — MoMo payments fail gracefully there with a clear error.

### 8.2 Use cases (all funnel through the same webhook)
| Domain | Row table | Status terminal |
|---|---|---|
| Restaurant orders | `orders` | `payment_status='paid'` |
| Event reservations (paid) | `event_reservations` | `payment_status='paid'` |
| Paid broadcasts | `broadcasts` | `payment_status='paid'` + status flips to `paid` → fan-out fires |
| Paid promotions | `promotions` | `payment_status='paid'` + status flips to `pending_review` |
| Vendor payouts (admin-triggered) | — | logged as `payout_completed` / `payout_failed` |

### 8.3 Webhook (`/api/payments/webhook`)
- Verifies the RFC-9421 `Content-Digest` header in production (sandbox bypasses).
- Dispatches based on which table owns the `payment_id`. Idempotent for re-deliveries.
- On `COMPLETED`: row flipped to paid, audit row written, customer + vendor / organizer pinged over WhatsApp.
- On `FAILED` / `REJECTED`: row flipped to failed; for reservations the held seats are released (events.tickets_sold + event_ticket_tiers.sold_count both decremented).

### 8.4 Client polling
- `/api/payments/status/[depositId]` returns the latest PawaPay status. Used by the checkout UI on `/order` and `/events/[id]` while the webhook hasn't arrived yet (5s interval, 90s timeout).

---

## 9. UI / design system

- **Brand colours** (Tailwind tokens in `tailwind.config.ts`): `brand` (orange #FF6B35), `brand-light`, `brand-dark`, `brand-badge`, `brand-darker`, `ink-primary/secondary/tertiary`, `surface`, `surface-muted`, `divider`.
- **Typography** — system stack (no custom font).
- **Layout** — mobile-first; max-w-2xl content column on most pages; max-w-5xl on home + events grids; restaurant grid uses 2 columns on mobile, 3 on tablet+, 4 on lg.
- **TopNav** — sticky header, logo "T&N" (full name "Tchop & Ndjoka" at ≥lg), city dropdown, desktop search, role-aware nav cluster, language toggle, map toggle on home + events, cart pill, account pill.
- **BottomNav** — mobile-only fixed bar, 3 tabs (logged-out) / 4 tabs (logged-in customer + vendor in client mode) / 4 tabs (vendor in restaurant mode). Hides on `/admin` and during the initial auth+mode probe so the wrong-state set never flashes.
- **Bilingual everywhere** — `<LanguageToggle />` flips between FR and EN; copy lives in `lib/translations.ts` (1000+ strings) and the `useBi()` helper for inline bilingual pairs.
- **Tn_* prefixed localStorage keys**: `tn_selected_city`, `tn_mode`, `tn_version`, `tn_imp_<promoId>`. Version-guarded so a release that bumps `CLIENT_VERSION` clears stale state on first load (`lib/clientVersion.ts`).
- **Cache headers** (`next.config.mjs` + `vercel.json`): HTML `no-cache, must-revalidate`; `/_next/static/*` `public, max-age=31536000, immutable`; `/api/*` `no-store`.

---

## 10. Pages & routes

### 10.1 Customer-facing
- `/` — home (restaurant list + map)
- `/restaurant/[id]` — restaurant detail
- `/order` — cart + checkout
- `/events` — events list (subscribe modal)
- `/events/[id]` — event detail (reservation + tier picker)
- `/events/submit` — submit a new event (login required)
- `/account` — login / signup / customer dashboard (Orders / Vouchers / Events / Profile / Restaurant / Team)
- `/join` — vendor signup form (public)

### 10.2 Vendor
- `/dashboard` — orders / menu / vouchers / settings (role-gated)

### 10.3 Admin
- `/admin` — landing
- `/admin/restaurants`, `/admin/orders`, `/admin/events`, `/admin/broadcasts`, `/admin/promotions`, `/admin/reports`, `/admin/vouchers`, `/admin/accounts`, `/admin/platformteam`, `/admin/profile` — per-tab pages (also mounted inside `/account` for an admin who's signed in there)

### 10.4 API
See `TECHNICAL-REQUIREMENTS.md` §3 for the full ~95-route inventory.

---

## 11. What's deliberately out of scope at v4.0

- Multi-tier *paid* checkouts in a single PawaPay deposit (current paid flow buys one tier per deposit).
- Refund automation when an organizer rejects a paid reservation — refunds are operator-manual for now.
- Daily-budget enforcement on promotions — billing is per-day upfront only.
- Native mobile apps (the PWA work is in `ROADMAP.md`).
- Real-time push notifications (the platform leans on WhatsApp instead).
- See `IDEAS-BACKLOG.md` for everything explicitly parked.
