# 🗺️ Tchop & Ndjoka — Project Roadmap (v4.0)

**Last updated:** 2026-05-20
**Status:** MVP live — pre-launch
**Live URL:** https://streetmenu.vercel.app
**Repo:** github.com/babnitch/streetmenu

For the *what* of the product see `FUNCTIONAL-SPEC.md`. For the *how* see `TECHNICAL-REQUIREMENTS.md`. For unbuilt ideas see `IDEAS-BACKLOG.md`.

---

## ✅ Phase 1 — Core platform (DONE)

### Restaurant discovery
- City-filtered list (Yaoundé, Abidjan, Dakar, Lomé) + Mapbox map
- City dropdown in TopNav, persisted in localStorage
- Restaurant detail page (menu, prices, categories, sticky tabs)
- 10 sample Yaoundé restaurants with full menus
- Search by name / cuisine / neighborhood (`?q=` deep-linkable)
- "Open now" filter (`?open=1` deep-linkable)
- Map pins coloured by computed open status

### Cart + checkout
- `cartContext` (localStorage-backed), one restaurant at a time, clear-on-switch prompt
- Auto-fill name + phone for logged-in customers
- Voucher input with client preview + server re-validation
- Pay-at-door path + PawaPay deposit path

### Vendor signup
- `/join` public form (name, owner, WhatsApp, city, neighborhood, cuisine, photo)
- WhatsApp `restaurant` keyword for mid-flow signup
- Admin approval queue in `/admin/restaurants`

---

## ✅ Phase 2 — WhatsApp ordering (DONE)

- Twilio webhook (`/api/whatsapp/incoming`) — single entrypoint
- `signup_sessions` for multi-step flows (signup, ordering, event reserve, photo upload, menu add)
- Bilingual customer commands: `commander`, `mes commandes`, `payer`, `mes bons`, `bon CODE`, `evenements`, `reserver XXXX`, `mes reservations`, `noter`, `signaler`, `aide`
- Bilingual vendor commands: `menu`, `Nom - Prix`, `prix Nom`, `dispo Nom`, `commandes`, `ok XXXX`, `preparer`, `pret`, `recupere`, `annuler`, `paye XXXX cash/mtn/orange`, `horaire`, `ouvrir`/`fermer`/`auto`, `temps 20 35`, `equipe`, `ajouter +X manager`, `invitations`, `retirer +X`, `suspendre`, `reactiver`
- Multi-restaurant team flow (`mes restaurants` selector)
- Photo upload mid-conversation (Twilio media → Supabase Storage)

---

## ✅ Phase 3 — Accounts & moderation (DONE)

- Customer + admin auth on one `/account` page (phone OTP vs email/password)
- `customers.status` lifecycle (active / suspended / deleted) + `restaurants.status`
- Soft-delete with undo window; hard-release of phone numbers
- Admin tabs: Restaurants, Orders, Vouchers, Reports, Accounts, Platform Team, Profile, Events, Broadcasts, Promotions
- Three admin roles (`super_admin` / `admin` / `moderator`) with per-tab gating
- `restaurant_team` + `team_invitations` (owner/manager/staff)
- `audit_log` with ~70 distinct actions
- `<ReportButton />` everywhere (`reports` queue, admin resolves)
- Customer self-suspend + self-delete; admin restore

---

## ✅ Phase 4 — Payments (DONE)

- PawaPay integration: `createDeposit`, `checkDepositStatus`, `createPayout`
- MNO routing: MTN MoMo (CMR/CIV/BEN), Orange (CMR/CIV/SEN), Moov (CIV/BEN), Free (SEN)
- Webhook handles 4 domains: orders, event reservations, broadcasts, promotions; idempotent
- Manual mark-paid by vendor (`paye XXXX cash` / `mtn 237…`)
- Vendor payout settings (`payout_phone`); admin-triggered payout endpoint
- Production webhook signature verification (RFC-9421 `Content-Digest`)
- `<PaymentBadge />` component used across customer + admin views

---

## ✅ Phase 5 — Vouchers (DONE)

- `vouchers` (code, % or fixed, min order, max uses, expiry, city / restaurant scope)
- `customer_vouchers` with `claimed_at` + `used_at`
- Welcome `BIENVENUE` code auto-assigned on first signup (10% off, city-scoped)
- Customer surfaces: claim input, "My vouchers" tab, checkout dropdown
- Vendor: voucher CRUD on `/dashboard` Vouchers tab + validate / consume flow
- Admin: platform-wide voucher management
- WhatsApp: `mes bons`, `bon CODE`

---

## ✅ Phase 6 — Events (DONE)

- `/events` list (city filter, category pills) + `/events/[id]` detail
- Event submission with cover photo, capacity, single-price OR multi-tier
- Trust gate: 3 approved events → `event_auto_approve=true`
- Reservations: free + pay-at-door (`/reserve`), paid PawaPay (`/pay`)
- Per-event `requires_confirmation` (manual approval flow with pending/confirm/reject)
- Per-event `reservations_open` (close/reopen the gate independently of event_status)
- Multi-tier ticketing (`event_ticket_tiers`): Early Bird, VIP, Kids, etc. + 3 presets
- Tier price-range display on event cards (Gratuit / 1,500 - 5,000 FCFA / mixed)
- Event likes + comments (with `event_comments.nickname` snapshot)
- Event subscriptions: city + optional category whitelist → WhatsApp alert on new event
- Paid broadcasts (50 FCFA/recipient, 1,000 FCFA min) — `<BroadcastPanel />` + admin tab
- Organizer dashboard: stats, settings, tiers, reservation management with filter tabs
- Category rename: Music→Concert / Food→Gastronomie / Art→Culture / Nightlife→Festival / BT|Club→BT/Club
- Locale-aware category labels

---

## ✅ Phase 7 — UI polish (DONE)

- Brand redesign: Tchop & Ndjoka name + T&N logo + orange palette
- Bilingual FR/EN throughout (~1000 keys × 2 languages in `lib/translations.ts`)
- `<TopNav />` + `<BottomNav />` with role/mode-aware tab sets, anti-flash guards
- Mode switcher (Client ⇄ Restaurant) for vendors
- Dynamic dashboard tab via `modeContext.dashboardTab` (avoids Next.js `?tab=` same-route skip)
- Restaurants + Events nav links always visible (even for vendors in restaurant mode)
- City dropdown, language toggle, map toggle, account pill, cart pill — all in TopNav
- Cache-Control headers prevent stale HTML; client-storage versioning (`CLIENT_VERSION`)
- `<PhoneInput />` with ~190-country dropdown, locale-aware A-Z, accent-insensitive search
- Custom domain not yet configured (still on `streetmenu.vercel.app`)

---

## ✅ Phase 8 — Ratings + social (DONE)

- `restaurant_ratings` with 1-5 stars + tag chips (food/service/value/cleanliness) + comment
- Gate: only customers with a `delivered` order at the restaurant can rate
- Aggregate endpoint + bulk loader (`/api/restaurants/ratings-summary?ids=…`)
- `<RestaurantRatingPanel />` for inline rating; `<EventSocialPanel />` for likes + comments
- Nicknames (`customers.nickname`) used to sign comments, 7-day change cooldown

---

## ✅ Phase 9 — Operations (DONE)

- Opening hours editor (`restaurant_hours`) + manual override (`open` / `closed` / null)
- Timezone-aware open-status computation (`lib/openingHours.ts`)
- Bulk open-status endpoint with 60s edge cache
- Prep-time range (5–120 min, default 20-35) per restaurant; "X-Y min" everywhere
- Allow-orders-when-closed flag for vendors who take advance orders
- Order status pipeline: pending → confirmed → preparing → ready → completed → delivered (+ cancelled)
- Real-time order updates via Supabase channel subscription on `/dashboard`
- Daily cron (`/api/admin/cleanup-expired`) purges stale signup sessions, OTP codes, expired invitations

---

## ✅ Phase 10 — Native ads (DONE — May 2026)

- `<PromotePanel />` for restaurant owners + verified publishers
- Three placements: `top_list` (2,000/day), `feed_card` (1,000/day), `banner` (500/day)
- Per-day billing, full upfront via PawaPay; admin approval before going live
- IntersectionObserver impressions + click tracking (sessionStorage dedupe)
- Self-promoter ad-filter (you never see your own ads)
- Admin tab: list / filter / approve / reject / pause / resume / pricing edit / revenue total

---

## 🔜 Phase 11 — Security hardening (NEXT — pre-launch blocker)

- [ ] Rate-limit `/api/auth/send-code` (max 5 codes/phone/24h, max 20/IP/hour)
- [ ] Rate-limit `/api/payments/initiate` to prevent deposit spam
- [ ] Rate-limit `/api/reports` to prevent abuse-button mash
- [ ] CSRF tokens on sensitive endpoints (cookie-only same-origin isn't sufficient long-term)
- [ ] Audit-log read UI inside admin (currently SQL-only)
- [ ] Production webhook re-test pass (PawaPay sandbox bypasses signature; prod must verify)
- [ ] Bcrypt rounds → 12 once we cross 1k admin/vendor sign-ins
- [ ] Secret rotation drill — confirm `JWT_SECRET` rotation procedure
- [ ] DB-level audit on PII reads via Postgres `pg_audit`
- [ ] Penetration test before public launch

---

## 🔜 Phase 12 — PWA + offline (NEXT)

- [ ] Service worker for offline-first cart + restaurant cache
- [ ] Web app manifest with proper icons + theme colour
- [ ] Add-to-home-screen prompt on iOS/Android browsers
- [ ] Background sync for orders queued offline
- [ ] Push notifications via Web Push API (FCM/APNS bridge)

---

## 🔜 Phase 13 — Launch prep

- [ ] Custom domain (tchopndjoka.com or similar) + DNS + SSL
- [ ] Twilio production WhatsApp template approval
- [ ] PawaPay production keys + payout testing
- [ ] Marketing site (currently `/` is the marketing surface too)
- [ ] Legal: terms of service, privacy policy, refund policy
- [ ] Analytics: Vercel Analytics or PostHog
- [ ] Error monitoring: Sentry
- [ ] Pre-launch bug bash with 20 invited testers in Yaoundé

---

## 🔜 Phase 14 — Post-launch

- [ ] Native mobile app (React Native or Capacitor wrap)
- [ ] Real-time push notifications (vendor side: order received; customer side: order ready)
- [ ] Admin analytics dashboard (orders/day, revenue, top restaurants, voucher CTR, promotion ROI)
- [ ] Vendor analytics: weekly summary email/WhatsApp
- [ ] Multi-language v2 — add Arabic, Wolof, Lingala
- [ ] Restaurant payout automation (currently admin-triggered)

---

## 🔜 Phase 15 — Scale

- [ ] Connection pooling (PgBouncer / Supabase pooler) once we cross 100 concurrent dashboards
- [ ] Read-replica for the open-status endpoint
- [ ] Per-region edge deployment if Africa latency becomes a real concern
- [ ] CDN images via Vercel's optimization with sharper compression presets
- [ ] Background workers for slow WhatsApp fan-outs (currently inline; OK at this scale)
- [ ] Database sharding by city (only after Vercel/Supabase recommend it)
- [ ] Multi-currency support beyond XAF/XOF

---

## Feature count summary (May 2026)

- **Pages:** 20 (customer + vendor + admin)
- **API routes:** ~95
- **Database tables:** 26
- **SQL migrations:** 28
- **WhatsApp commands:** 35+
- **Languages supported:** 2 (FR/EN)
- **Cities:** 5 (Yaoundé, Abidjan, Dakar, Lomé, Cotonou)
- **Countries in PhoneInput:** ~190
- **MNO correspondents:** 9 (PawaPay)
- **Event categories:** 9
- **Audit-log actions:** ~70
- **TypeScript files:** ~120
- **Lines of code:** ~30,000

Built in 8 months. Solo dev with Claude in the loop.
