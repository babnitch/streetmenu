# 💡 Tchop & Ndjoka — Ideas Backlog

Things we've discussed but haven't built. Some are quick wins; most need a design pass before we commit. Nothing here is committed to a timeline — `ROADMAP.md` is the source of truth for what's scheduled.

For shipped features see `FUNCTIONAL-SPEC.md` / `ROADMAP.md`.

---

## 1. New event categories

Current 9: Concert, Festival, BT/Club, Sport, Culture, Gastronomie, Enfants, Business, Autre.

Candidates surfaced by partner organizers:

| Category | Use case |
|---|---|
| Excursion | Day trips / nature outings (Mont Cameroun hikes, Île de Gorée tours) |
| Conference | Professional gatherings, summits |
| Meet & Greet | Author signings, fan meets |
| TV Show | Live tapings, talk-show audiences |
| Theater | Plays, comedy sets, improv nights |
| Workshop | Cooking class, photography, dance, language |
| Race | Marathons, cycling, kart racing |
| Ceremony | Weddings, traditional ceremonies (organizers want them listed without exposing the guest list) |
| Fair | Trade fairs, craft fairs, food fairs |

Implementation cost: a tiny migration + add to `CATEGORIES` in 5 places + extend `categoryLabel` map.

---

## 2. Dynamic cities (auto-add on registration)

Today the city list is hardcoded in `lib/cityContext.tsx` + `app/page.tsx` `CITY_CENTERS` + `lib/phoneValidation.ts` `CITY_TO_COUNTRY`. Adding Cotonou required code changes in 4 files.

Idea: when a customer signs up from a city that isn't in the list, prompt for confirmation and create a `cities` row dynamically. Admin reviews + adds the Mapbox center coordinates + IANA timezone + country mapping before the city becomes a public filter option.

DB shape: `cities (id, name, country_iso, timezone, lat, lng, is_published, pending_approval, requested_count)`.

Trade-off: more flexibility vs more pre-approval work for the admin team. Probably worth doing once we have 50+ "I'm in [city X]" signup requests piling up.

---

## 3. Payment protection / escrow

Vendors sometimes worry that customers will pay then dispute; customers sometimes worry vendors will take the money and not deliver. Four options discussed:

### 3.1 Hold-and-release escrow
- PawaPay deposit lands in a platform sub-wallet
- Released to the vendor after the order is marked `delivered` (or 24h later, whichever comes first)
- Disputed orders go into a manual review queue
- **Pro**: maximum trust
- **Con**: needs PawaPay sub-account support or a separate "platform" wallet; weekly payout batches

### 3.2 Per-order delayed payout
- Deposit settles directly into vendor wallet (current flow)
- Platform schedules an automatic payout reversal if order isn't delivered within 24h
- **Pro**: no platform balance management
- **Con**: reversal isn't a PawaPay primitive — would need vendor consent

### 3.3 Dispute window with reserve
- Vendor receives full amount immediately
- 10% reserve is held back for 7 days as a dispute buffer
- Released automatically if no dispute filed
- **Pro**: keeps daily cash flow for vendors
- **Con**: most disputes happen on the day, so 7d is overkill

### 3.4 Reputation bond
- New vendors deposit a one-time bond
- Bond gets drawn down by disputes; if depleted, vendor must top up
- Tenured vendors with 50+ deliveries skip the bond
- **Pro**: no per-order overhead
- **Con**: barrier to onboarding new vendors

**Likely path:** start with §3.3 (reserve) since it doesn't require PawaPay product changes; add §3.1 (full escrow) only if disputes spike past 5% of orders.

---

## 4. QR code reservation proof

`qrcode.react` is already in `package.json`. Idea:

- Confirmed event reservations get a unique short code (6-char base32, encoded in the QR)
- Stored on `event_reservations.qr_code` (UNIQUE)
- Customer screen shows the QR + the short code as fallback
- Organizer dashboard adds a scanner (web camera via `getUserMedia`) → POST `/api/events/[id]/reservations/scan` → flips reservation to `attended` + bumps the count
- Anti-fraud: scanning the same QR twice returns "Already used at HH:MM" with a red border on the scanner UI
- Code expires at `event.date + 24h` so customers can't sell their unused ticket on a secondary market

Implementation cost: medium. The QR scanner is the longest piece (test on real devices for permission + camera-feed reliability).

---

## 5. Favourite restaurants

- Heart toggle on restaurant cards + detail page
- `customers.favourite_restaurant_ids` UUID[] OR a new join table `customer_favourites`
- Surfaces:
  - "Favoris" carousel above the home list (max 10 restaurants, horizontal scroll)
  - `/account` → Vouchers tab gets a "Favoris" sub-tab
  - Quick-reorder: tap a favourite → directly jump into `/order` with the cart pre-filled from the last completed order at that restaurant
- WhatsApp: `mes favoris` → list with reorder shortcuts

Trivial DB, ~½ day of UI work. Mostly waiting on a need from real users.

---

## 6. Advanced search & filters

Today's search is a single string matching name / cuisine / neighborhood. Power users want:

- **Food**: search restaurants serving a specific dish ("Ndolé", "Poulet braisé"). Requires `menu_items` index.
- **Cuisine type**: chip filter (already partially there via the cuisine_type pill on cards)
- **Price tier**: $ / $$ / $$$ — auto-derived from menu_items median
- **Neighborhood**: dropdown of all known neighborhoods in the current city
- **Rating**: ≥4 stars / ≥3 stars
- **Open now**: already done
- **Has delivery**: needs delivery feature first (see §10)
- **Has online payment**: filter on `payment_enabled=true`

Probably ship as a "Filters" sheet that slides up from the bottom on mobile, mirroring how OpenTable / Yelp do it.

---

## 7. Social media integration

Auto-cross-post when:
- Vendor adds a menu item with photo → tweet/post draft on the restaurant's connected Facebook/Instagram
- Organizer publishes an event → schedule a post on the organizer's profile
- Daily special is set → "Today's special at [restaurant]: [item] - [price] FCFA"

Implementation: OAuth connection in `/account` (Facebook Login + Instagram Graph API), `social_accounts` table holds tokens, queue worker posts via Graph API.

Risks:
- API token refresh is annoying (Facebook tokens expire every 60d)
- One bad post = upset restaurant — needs a preview + cancel window
- Instagram Graph API requires a Business account; not every restaurant has one

Phase this in with restaurants we co-launch with first.

---

## 8. Push notifications

Now we lean on WhatsApp. PWA / native push would let us:
- Alert vendors instantly when a new order lands (vs WhatsApp lag)
- Notify customers when their order is ready for pickup
- Re-engage subscribers when a new event hits their category

Web Push via service-worker subscription, FCM/APNS bridge for the eventual native app.

Caveat: every push slot we burn is a slot we can't use for marketing later. Push budget is precious.

---

## 9. Analytics

Three audiences want different things:

| Audience | Wants |
|---|---|
| Vendor | Daily orders, top items, return-customer %, voucher CTR, prep-time vs SLA |
| Organizer | Reservations by source (web/WhatsApp/promo), tier conversion, refund rate |
| Admin | GMV by city, payment-failure rate, MNO breakdown, promotion ROI, churn |

Buy-or-build call. Probably start with PostHog for product analytics and a hand-rolled "Vendor weekly summary" sent over WhatsApp.

---

## 10. Delivery

Currently only pickup + dine-in. Delivery means:

- Couriers (recruit + onboard + verify)
- Delivery fee math (distance × zone rate × surge)
- Live tracking (driver location → customer)
- Cash on delivery handling (if driver collects, settlement to vendor + commission to platform)

This is a separate product. We won't ship it inside `streetmenu` — we'd spin up a sibling app.

---

## 11. Loyalty programs

Punch-card style: every Nth order at the same restaurant earns a free item. Stamps live on `customer_vouchers` with a special voucher template.

Restaurant-level toggle: each owner picks "10 orders → 1 free meal" or similar. Auto-issues a single-use voucher when the threshold is hit.

Low-hanging once vouchers V2 ships.

---

## 12. Multi-language v2

Add Arabic (RTL) + Wolof + Lingala. Two challenges:

1. RTL requires a layout review of every page (TopNav, cart, dashboard, modals)
2. Wolof and Lingala don't have stable Unicode shaping like Arabic — we'd be the first food app to localise into them, which is a marketing win but a translation cost

Cost: ~3 days of layout work + the translator's invoice for each language.

---

## 13. Native mobile app

React Native vs Capacitor wrap. Capacitor is faster (we ship the existing PWA inside a WebView shell), RN is more native-feeling.

The unique value-add of native:
- Reliable push (PWA push on iOS still flaky)
- Instant-load (no first-paint TTFB cost)
- Camera + biometric login

Wait until DAU justifies the maintenance burden. App-store reviews are a separate ops problem.

---

## 14. AI features

Speculative pile — not committed:

- **Menu-photo extraction**: vendor takes a photo of their printed menu, OCR + LLM extracts items + prices, vendor confirms
- **Spam-comment detection**: classifier on `event_comments` body
- **Voucher-code generator**: LLM suggests promo codes based on restaurant theme
- **Multilingual transcription**: WhatsApp voice notes → text → command parsing
- **Smart prep-time estimator**: ML on historical `confirmed_at` → `ready_at` deltas; surface as "Currently 15 min faster than usual"

All of these are nice-to-have. None of them justify a roadmap slot today.

---

## 15. Misc

- **Voice ordering** via WhatsApp voice notes (Whisper → command parser)
- **Recipe sharing**: vendors publish a recipe per dish; SEO bonus
- **Group ordering**: cart shared across multiple customers with split-bill
- **Group reservation**: one organizer reserves a block, friends join with their own contact info
- **Cashback wallet**: alternative to vouchers — flat % cashback on every order, balance redeemed at checkout
- **Vendor onboarding video** embedded in `/join`
- **AI-powered tag suggestions** for new menu items (vendor types "Ndolé" → suggests "Camerounais, Plat principal, Sauce")
- **Calendar export** (.ics) for confirmed event reservations
- **WhatsApp templates dashboard** for admins to edit the bot's bilingual copy without code
- **Webhook for partners** (`POST /webhooks/{event}`) — restaurants who want to mirror orders into their own POS

---

## How to use this file

When a new idea surfaces:
1. Add it under the right section (or make a new section if none fits).
2. Capture *why* it's interesting in 1-2 sentences, plus implementation cost / risks.
3. Don't promise a timeline — that lives in `ROADMAP.md` only after we've decided to build it.

When something *gets* built:
- Move it from here to `ROADMAP.md` (under the phase that shipped it).
- Update `FUNCTIONAL-SPEC.md` if user-facing, `TECHNICAL-REQUIREMENTS.md` if structural.
