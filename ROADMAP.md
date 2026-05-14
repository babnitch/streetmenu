# 🗺️ Ndjoka & Tchop — Project Roadmap

**Last updated:** May 14, 2026
**Status:** MVP Live — Pre-Launch Phase
**Live URL:** https://streetmenu.vercel.app
**Repo:** github.com/babnitch/streetmenu

---

## ✅ Phase 1: Core Platform (COMPLETED)

### Restaurant Discovery
- [x] Restaurant list by city with search
- [x] Fullscreen map with restaurant pins (Mapbox)
- [x] City selector: Yaoundé, Abidjan, Dakar, Lomé
- [x] Restaurant detail page with menu, prices, categories
- [x] 10 sample Yaoundé restaurants with full menus
- [x] Add to cart functionality
- [x] **Opening hours + manual override** — weekly schedule per restaurant (`restaurant_hours`), timezone-aware (Africa/Douala default, Africa/Abidjan / Dakar / Lome per city), overnight windows supported. Computed open/closed via `GET /api/restaurants/open-status?ids=…` (60s edge cache), surfaced on home cards + restaurant detail with a "Closes at HH:MM" line. Owner-only schedule editor + open/close manual override on the dashboard Settings tab. Audited as `schedule_updated` / `manual_override_set` / `manual_override_removed`. (Map pin colours + WhatsApp `ouvrir`/`fermer`/`horaire`/`auto` + closed-ordering warning deferred to a follow-up batch.)

### Events Section
- [x] Events listing page with 7 categories (including BT/Club)
- [x] Event detail page with WhatsApp contact button
- [x] Public event submission form for promoters
- [x] 7 sample events (one per category)
- [x] Admin approval flow for submitted events
- [x] **Event reservations (free + pay-at-door)** — quantity + capacity + sold-out gate
- [x] **Paid event reservations via PawaPay** — same pipeline as restaurant orders, webhook + poll fallback for `event_reservations`, seats released on failed payment
- [x] **Organizer "Mes événements" tab** in /account — reservation list, ✅ attendance, ❌ cancel with refund flag
- [x] **Admin events panel: reservation count + revenue + commission** badges per row
- [x] **WhatsApp event commands** — `mes reservations`, `reserver XXXX`, `publier`, `mes evenements`
- [x] **Light publisher trust model** — any logged-in customer submits; 3 admin approvals auto-grant `event_auto_approve`; admin can revoke
- [x] **10% platform commission on paid events** — `commission_rate` per event, `commission_amount` stored per reservation; organizer panel surfaces gross / commission / net

### Restaurant Ratings (Uber Eats style)
- [x] **1-5 star ratings + predefined tag picker** — positive tag set when ≥4 stars, negative when ≤3, both at 3
- [x] **Verified-buyer gate** — only customers with a delivered order at this restaurant can rate; one rating per order
- [x] **Anonymous aggregate** — average, count, 1-5 distribution bars, top tags; no individual reviews visible
- [x] **Card + detail page badges** — `⭐ N.N (count)` shown on home cards (bulk endpoint) and the restaurant detail page
- [x] **Vendor dashboard panel** — aggregate + distribution + top tags + 30-day trend (up/down/flat). No reply, no dispute, no individual ratings
- [x] **WhatsApp `noter` command + deep link** — `noter / rate` jumps to `/restaurant/[id]#rate`; the page auto-opens the rating modal from the hash
- [ ] **Post-delivery WhatsApp prompt** — Cron job to fire 2h after order moves to `delivered` (deferred)
- [x] **Event likes** — toggle heart, optimistic update, bulk like-count summary on event cards
- [x] **Event comments** — nickname-signed (never phone), 500-char cap, paginated 10-per-page, inline nickname prompt on first comment
- [x] **Nickname system** — 3-20 chars, alphanumeric + `._-`, no phone-like 4+ digit sequences, 30-day cooldown, editable in /account profile
- [x] **Admin soft-delete on comments** — `is_deleted`/`deleted_by`/`deleted_at` audited; UI lands with reporting in the next batch
- [x] **Reporting + admin moderation** — 🚩 button on restaurant + event detail + per-comment row, modal with reason dropdown + optional description, `POST /api/reports` (login-gated, anonymous to the reported party). Admin `Signalements / Reports` sub-tab with pending/reviewed/action_taken/dismissed filters + counts, expandable row with reporter info (admin-only), `PATCH /api/admin/reports/[id]` for mark-reviewed / dismiss / soft-delete-comment + admin notes. WhatsApp `signaler / report` returns deep links to the customer's most-recent restaurant + event so they can report from the right page.

### Vendor System
- [x] Vendor self-signup form (/join)
- [x] Admin approval workflow
- [x] Vendor dashboard: manage menu, view orders, validate vouchers

### Customer Features
- [x] Customer signup/login with phone number
- [x] Order page: cart review, customer name/phone, order submit
- [x] Order history in customer account
- [x] Welcome voucher (10% off first order)
- [x] Short memorable voucher codes (TCHOP-XXXX)
- [x] Voucher claiming and validation system

### Admin Panel
- [x] Admin dashboard with tabs: restaurants, orders, events, vouchers
- [x] Approve/reject vendors
- [x] Approve/reject events
- [x] Manage vouchers

### Infrastructure
- [x] Next.js 14 + Tailwind CSS frontend
- [x] Supabase (Postgres) database
- [x] Vercel hosting
- [x] Bilingual FR/EN toggle throughout

---

## 🔄 Phase 2: WhatsApp Integration (IN PROGRESS)

### Twilio WhatsApp Setup
- [x] Twilio account created
- [x] WhatsApp Sandbox configured
- [x] Environment variables set (.env.local + Vercel)
- [x] Switched from Auth Token to API Keys
- [x] Webhook URL configured in Twilio

### Inbound: Vendor Menu via WhatsApp
- [x] Webhook route: /api/whatsapp/incoming
- [x] Vendor lookup by phone number
- [x] Parse menu items from messages ("Ndolé - 2500")
- [x] Download and store photos to Supabase Storage
- [x] Commands: aide/help, menu, commandes/orders, restaurant
- [x] Bilingual FR/EN replies
- [ ] **TESTING**: Confirm API credentials (TWILIO_API_KEY_SID must start with SK)
- [ ] **TESTING**: Confirm WhatsApp replies received end-to-end

### WhatsApp Onboarding (NEW)
- [x] Customer signup via WhatsApp (name + city, 2 steps)
- [x] signup_sessions table for multi-step state machine
- [x] Vendor signup via WhatsApp (4 steps: name, neighborhood, cuisine, city)
- [x] Commands for customers without restaurant: aide, restaurant
- [x] Commands for pending vendors: pending approval message
- [x] Cancel command at any step ("annuler" / "cancel")
- [x] 1-hour session expiry with auto-cleanup
- [x] Unified accounts: same phone works on WhatsApp and web

### Web Auth: WhatsApp OTP (NEW — replaces Supabase SMS)
- [x] POST /api/auth/send-code — generates 4-digit code, stores in verification_codes, sends WhatsApp
- [x] POST /api/auth/verify-code — verifies code, upserts customer, assigns welcome voucher
- [x] /account page uses WhatsApp codes instead of Supabase SMS OTP
- [x] New customer flow: phone → name + city fields → WhatsApp code → dashboard
- [x] Existing customer flow: phone → WhatsApp code → dashboard
- [x] customers table as single source of truth (unified with WhatsApp signups)
- [x] verification_codes table (4-digit, 5-min TTL)

### Outbound: Order Notifications
- [x] Notification service (lib/whatsapp.ts)
- [x] Order notification route: /api/whatsapp/notify-order
- [x] Message templates: new order, confirmed, ready
- [ ] **TESTING**: Test end-to-end order notification flow
- [ ] Hook into existing order submission flow

### Team Invitations (NEW — April 2026)
- [x] team_invitations table (supabase-team-invitations.sql)
- [x] POST /api/restaurants/[id]/invite — owner creates invitation or adds direct
- [x] GET /api/restaurants/[id]/invite — list pending invitations
- [x] DELETE /api/restaurants/[id]/invite/[invitationId] — cancel pending
- [x] WhatsApp: "ajouter/inviter +XXX role" falls back to invitation when number unregistered
- [x] WhatsApp: "accepter" / "refuser" with auto-registration for new invitees
- [x] WhatsApp: "invitations" lists pending; "annuler invitation +XXX" cancels
- [x] Dashboard Team tab: pending invitations section + per-row Cancel
- [x] Audit log: team_invitation_{sent, accepted, declined, cancelled, expired}
- [x] 7-day lazy expiry — stale rows filtered at read time

### Mode Switcher (NEW — April 2026)
- [x] lib/modeContext.tsx — client/restaurant mode + topRole probe
- [x] Slim mode bar below TopNav, only for users with a team role
- [x] TopNav desktop: mode-aware link set (Restaurants/Events/Orders vs Orders/Menu/Team/Settings)
- [x] BottomNav: mode-aware tab variants with role gating
- [x] /dashboard ?tab= deep links + stubs for team/settings tabs

### WhatsApp Remaining
- [ ] Production Twilio WhatsApp number (~$15/month)
- [ ] Vendor sends "ok XXXX" to confirm orders
- [ ] Customer receives order status updates

---

## 🔴 Phase 3: Security Fixes (CRITICAL — DO BEFORE LAUNCH)

### Vuln 1: Missing Twilio Webhook Signature Verification
- **Severity:** HIGH
- **File:** app/api/whatsapp/incoming/route.ts
- **Risk:** Anyone can forge POST requests impersonating Twilio, access PII (customer names/phones), and pollute restaurant menus with fake items
- **Fix:**
  - [ ] Add TWILIO_AUTH_TOKEN back to Vercel env vars (for validation only)
  - [ ] Install twilio npm package: `npm install twilio`
  - [ ] Add signature validation before processing any request:
    ```
    import twilio from 'twilio'
    const valid = twilio.validateRequest(authToken, sig, url, params)
    if (!valid) return new NextResponse('Forbidden', { status: 403 })
    ```
  - [ ] Test that forged requests are rejected

### Vuln 2: Admin Panel Has No Server-Side Authorization
- **Severity:** HIGH
- **File:** app/admin/restaurants/page.tsx + Supabase RLS policies
- **Risk:** Anyone with the public anon key (visible in page source) can approve/reject/delete any restaurant, deactivate vendors, or modify any data — no authentication needed
- **Fix:**
  - [ ] Create server-side API routes for all admin mutations
  - [ ] Verify hashed ADMIN_PASSWORD from Authorization header before executing writes
  - [ ] Replace USING (true) RLS policies with proper role-based policies
  - [ ] Move admin operations to use SUPABASE_SERVICE_ROLE_KEY server-side only
  - [ ] Test that direct Supabase API calls with anon key are blocked

### Credential Rotation (Completed)
- [x] Twilio Auth Token → switched to API Keys
- [x] Created GitHub Personal Access Token for pushes
- [x] Added CLAUDE_API_KEY to GitHub Secrets for security reviews
- [ ] Rotate Mapbox token (old one was exposed)
- [ ] Rotate Supabase anon key (old one was exposed)
- [ ] Change ADMIN_PASSWORD (old one was exposed)
- [ ] Set up GitHub Actions automated security review on PRs

### Security Best Practices
- [x] .env.local in .gitignore
- [x] Secrets removed from git history
- [ ] Enable Supabase Row Level Security (proper policies, not USING true)
- [ ] Add rate limiting to all API routes
- [ ] Add input sanitization to WhatsApp message parser
- [ ] HTTPS-only cookies for customer sessions
- [ ] Add CORS headers to API routes

---

## ⬜ Phase 4: Payment & Business (NOT YET BUILT)

### Mobile Money Integration
- [ ] Research providers: MTN MoMo, Orange Money for Cameroon
- [ ] Integrate payment API
- [ ] Order payment flow: cart → pay → confirm
- [ ] Payment confirmation to vendor
- [ ] Transaction history for customers and vendors

### Vendor Monetization
- [ ] Vendor subscription plans
- [ ] Commission per order
- [ ] Vendor analytics dashboard (orders, revenue, popular items)

---

## ⬜ Phase 5: Growth & Distribution (NOT YET BUILT)

### Mobile PWA
- [ ] Add manifest.json for installable PWA
- [ ] Service worker for offline support
- [ ] Push notifications for orders
- [ ] App install prompt

### SEO & Sharing
- [ ] Dynamic meta tags for each restaurant page
- [ ] Open Graph images for social sharing
- [ ] Shareable restaurant links with preview
- [ ] Sitemap.xml generation
- [ ] Structured data (JSON-LD) for restaurants

### Real Vendor Onboarding (Yaoundé)
- [ ] Identify 20 target restaurants in Yaoundé
- [ ] Create onboarding WhatsApp message template
- [ ] Visit vendors, help them sign up
- [ ] Collect real menus and photos
- [ ] Remove sample data, replace with real vendors

---

## ⬜ Phase 6: Scale (FUTURE)

### Multi-City Expansion
- [ ] Launch Abidjan
- [ ] Launch Dakar
- [ ] Launch Lomé
- [ ] City-specific landing pages

### Advanced Features
- [ ] Customer reviews and ratings
- [ ] Delivery tracking
- [ ] Favorite restaurants
- [ ] Order scheduling (pre-order for later)
- [ ] Restaurant recommendations based on location
- [ ] Analytics dashboard for admin

---

## 🛠️ Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 14 + Tailwind CSS |
| Database | Supabase (Postgres) |
| Hosting | Vercel |
| Maps | Mapbox |
| WhatsApp | Twilio API (API Keys) |
| Storage | Supabase Storage (menu-images) |
| Repo | github.com/babnitch/streetmenu |

---

## 📊 Current Priority Order

1. **Fix WhatsApp webhook** — get aide/menu/commandes working end-to-end
2. **Fix security vulnerabilities** — Twilio signature validation + admin auth
3. **Rotate exposed credentials** — Mapbox, Supabase anon key, admin password
4. **Test full order flow** — customer orders → vendor gets WhatsApp notification
5. **Real vendor onboarding** — sign up 5-10 real restaurants in Yaoundé
6. **Mobile Money** — enable payments
7. **PWA** — make it installable on phone

---

## 📝 Notes

- Always update this file when completing or adding tasks
- Run `/security-review` in Claude Code before every deployment
- Never commit secrets to git — use .env.local locally and Vercel env vars for production
- All user-facing content must be bilingual FR/EN
