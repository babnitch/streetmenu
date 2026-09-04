# Functional Regression Suite — Plan

Status: **proposed, not yet implemented.** No test files have been written against
this plan. It covers *functional correctness only* — security/authz probing is a
separate exercise (see `SECURITY-AUDIT.md`).

Goal: a repeatable suite that verifies core user / vendor / event flows still work
after a deploy.

---

## 0. Ground rules

**Runner: keep `tsx`, no new framework.** The ten existing `scripts/test-*.ts`
already encode the whole harness — `.env.local` loader, service-role client,
`assert()`, `seed()`/`cleanup()` in `try/finally`, forged `sm_session` JWTs, fake
`+999…` phones. Vitest/Jest would buy parallelism and a reporter we don't need, and
cost a dependency plus config for `@/*` path resolution and the
`NextRequest`-importing libs. `npx tsx` already resolves `@/*` via `tsconfig.json`
(that's how `test-ordering-parser.ts` reaches `lib/whatsapp/ordering.ts` today).

One dependency change that *is* recommended: pin `tsx` in `devDependencies`. It is
currently resolved through `npx` on every invocation — fine locally, unreliable and
slow in CI.

**Two run targets, and they aren't equivalent:**

- `BASE_URL=http://localhost:3001` — local server, live Supabase. What the current
  scripts do.
- `BASE_URL=https://<deployed>` — real post-deploy verification. Requires the
  *deployed* `JWT_SECRET` locally to forge session cookies.

Which one we target decides whether this suite verifies "the deploy" or "the code".

---

## 1. Flow inventory

Legend for **Layer**: `PURE` = no I/O · `DB` = service-role client only ·
`API` = needs a running server · `EXT` = external provider involved.

### 1a. Pure logic — no server, no DB, no cleanup, ~instant

| # | Flow | Asserts | Layer |
|---|---|---|---|
| 1 | `parseOrder` (**exists**: `test-ordering-parser.ts`) | number/name/compact syntaxes, dup-merge, qty bounds, 6 error classes | PURE |
| 2 | `isRestaurantOpen` / `nextTransitionLine` / `formatHoursForDisplay` | open mid-window, closed before/after, past-midnight close (22:00→02:00), `is_closed` day, no-rows fallback, manual override wins, `timezoneForCity` per city | PURE |
| 3 | `validatePrepTime` / `formatPrepTime` | floor 5 / ceil 120, min>max rejected, default 20–35 rendering | PURE |
| 4 | `normalizePhone` / `samePhone` / `validateLocalPhone` / `composeFullPhone` / `detectCountry` / `splitIntoCountryAndLocal` | the format-equivalence set that `test-check-phone` covers at HTTP level, asserted directly and cheaply | PURE |
| 5 | `paymentMode`: `normalizeMode`, `modeFromLegacy` ⇄ `legacyEnabledFromMode`, `canPayOnline`, `canReserve`, `effectiveWebMode`, `effectiveWhatsAppMode` | 3-way mode matrix incl. free-event forcing to `reservation_only` | PURE |
| 6 | `computeDiscount` / `deriveStatus` / `isPercentDiscount` | percent vs fixed, rounding, discount > total clamps at 0, `expired`/`exhausted`/`inactive` derivation | PURE |
| 7 | `tierAvailability` / `summarisePrice` | sold-out, not-yet-open, closed, min/max price summary | PURE |
| 8 | `daysBetween` / `computeCost` / `arrangePromoted` | cost math per placement, ≤2 promos per page, inject-every-N interleave, short lists | PURE |
| 9 | `tagsForRating` / `sanitizeTags` / `aggregate` | positive/negative tag split by score, unknown tags dropped, average + tag histogram | PURE |
| 10 | `validateNickname` / `nicknameCooldownDaysRemaining` / `displayNickname` | length, charset, phone-like rejection, cooldown arithmetic, fallback to `name` | PURE |
| 11 | `isPastEvent` / `todayISO` | boundary at local midnight, null-safe | PURE |
| 12 | `sanitizeText` / `sanitizePhone` / `sanitizeCode` | truncation, control chars, tag stripping | PURE |
| 13 | `computeBroadcastCost` / `formatBroadcastMessage` | per-recipient pricing, FR/EN wrapper, unsubscribe footer keyword matches router | PURE |
| 14 | `rateLimit()` | Nth call inside window returns a result, resets after window (fake clock) | PURE |
| 15 | `randomReservationCode` | charset + length, no ambiguous glyphs | PURE |

### 1b. DB layer — service-role client, no server

| # | Flow | Asserts | Layer |
|---|---|---|---|
| 16 | `validateVoucher` against real rows | wrong restaurant, expired, inactive, wrong city, `min_order` not met, per-customer max — the branches `test-vouchers` currently reaches only through HTTP | DB |
| 17 | `assignWelcomeVoucher` / `consumeVoucherForOrder` / `consumeVoucherForReservation` | claim row created, `current_uses` bumped exactly once, claim marked used | DB |
| 18 | `generateReservationCodes(n)` | n distinct codes, none colliding with existing `event_reservations` | DB |
| 19 | **Migration smoke** — highest post-deploy value | `orders.status` accepts `cancelled` + `delivered`; `restaurants.prep_time_min/max` exist; `customers.notification_channel` exists; `message_log` table exists; `payment_mode` on `restaurants` + `events`; `event_subscriptions` exists; `reservation_code` column exists | DB |
| 20 | `restaurant_team` owner trigger | inserting a restaurant with `customer_id` auto-creates the `owner` row (the behaviour `test-vendor-order-actions.ts` works around with `upsert`) | DB |
| 21 | Soft-delete semantics | `deleted_at` / `status='deleted'` rows excluded from public reads | DB |

### 1c. API layer — needs a running server

| # | Flow | Asserts | Layer |
|---|---|---|---|
| 22 | **WhatsApp ordering E2E** (**exists**) | `commander` → pick → qty → `oui` → `pending`; vendor `ok`/`pret`/`annuler`; session cleared | API |
| 23 | **Vendor order status** (**exists**) | full role × transition matrix, invalid transitions, audit rows | API |
| 24 | **Vouchers** (**exists**) | claim / double-claim / apply / consume / admin auto-code / delete-guard / vendor scoping | API |
| 25 | **Vendor dashboard** (**exists** ×2) | legacy owner via `customer_id`, soft-deleted excluded | API |
| 26 | **notify-order** (**exists**) | recipient dedup (direct `whatsapp` + owner team row → 1), both legs attempted | API + EXT-soft |
| 27 | **approve-welcome** (**exists**) | pending→active, audit row, welcome sent once (idempotent) | API + EXT-soft |
| 28 | **check-phone / send-code** (**exists**) | format equivalence, `needsRegistration`, no duplicate customers | API + EXT-soft |
| 29 | `orders/create` | session identity wins over body; guest requires name+phone; item-key whitelist (extra keys dropped); `order_type` → `payment_status` mapping; totals rounded | API |
| 30 | **Menu CRUD** | POST creates with `restaurant_id` from URL not body; PATCH edits; DELETE removes; `owner\|manager` allowed, `staff` 403; category defaults to `Autre`; invalid price 400; audit row written | API |
| 31 | **Opening hours** | POST replaces the week via upsert; malformed rows dropped silently; owner-only (manager 403); GET returns 7 ordered days; `/restaurants/open-status` reflects them | API |
| 32 | **Open toggle / override** | `/open` writable by staff, `/override` not; only `is_open` mutated — `status`, `is_active`, payment fields unchanged after the call | API |
| 33 | **Team + invitations** | invite create → row in `team_invitations`; accept promotes to `restaurant_team`; decline; duplicate invite; remove member; owner cannot be removed | API |
| 34 | **Events lifecycle** | submit (non-auto-approve → `is_active=false`) → admin approve → `is_active=true`; reserve (single-price) → `event_reservations` row + `reservation_code` + `tickets_sold` bumped by quantity; `requires_confirmation` → `pending` then confirm/reject; attend; cancel restores counters; past-event rejected; capacity exhaustion rejected | API |
| 35 | **Ticket tiers** | tier CRUD; multi-tier reserve inserts one row per tier with price snapshot; `sold_count` per tier; sold-out tier rejected | API |
| 36 | **Event vouchers** | `/events/[id]/vouchers/validate` accept/reject; discount split across multi-row bookings sums to the total | API |
| 37 | **Customer history** | `/customer/orders` and `/customer/reservations` return only the session's own rows; guest orders (null `customer_id`) excluded | API |
| 38 | **Ratings** | `/rate` writes one row per customer per restaurant (re-rate updates); `/rating` and `/ratings-summary` aggregate correctly | API |
| 39 | **Subscriptions** | subscribe by city+category; `/my` lists; unsubscribe deactivates; `countMatchingSubscribers` matches | API |
| 40 | **Promotions** | create → `pending_review`; admin approve → `active`; `/active` returns it; impression + click counters increment; eligibility gate | API |
| 41 | **Reports** | create report; admin resolve; rate limit 5/session/hour respected | API |
| 42 | **Twilio status callback** | POST a synthetic Twilio status payload → `message_log.status` transitions `queued`→`delivered`/`failed` (no real Twilio needed) | API |
| 43 | **PawaPay webhook** (state machine only) | POST synthetic deposit-completed payload → order/reservation `payment_status` flips; signature check is skipped in sandbox mode, so this needs no provider call | API |
| 44 | **Read-only prod smoke** | `MeResto 854381d6…` and customer `c1f5f049…` still resolve; `GET /api/restaurants/854381d6…` 200; menu non-empty; `/api/restaurants/open-status` 200. **Never mutated** | API (read-only) |

### 1d. WhatsApp router commands testable without Twilio

The webhook is a plain form-POST; Twilio only matters for the *outbound* leg, which
fails harmlessly against `+999…` numbers. So the router's DB effects are fully
testable — the highest-coverage-per-effort area after ordering.

| # | Commands | Asserts | Layer |
|---|---|---|---|
| 45 | `aide`, `aide+`, `en`/`fr` | `preferred_language` flips; no session residue | API |
| 46 | `ouvrir` / `fermer` / `auto` | `restaurants.is_open` + override state | API |
| 47 | `horaires` multi-step | `restaurant_hours` rows written | API |
| 48 | `menu` + the 2-part/3-part add-item syntax | `menu_items` created; `staff` blocked | API |
| 49 | `equipe`, `invitations`, `accepter`/`refuser` | team + invitation rows | API |
| 50 | `commandes`, `mes restaurants`, `mes abonnements`, `desabonner` | read paths + unsubscribe write | API |
| 51 | `reset`, `annuler` (non-ordering) | `signup_sessions` cleared | API |

### Marked for stub/skip

- **Twilio outbound** (#26, #27, #28, #45–51): fire-and-log. Assert on `message_log`
  rows and route responses, never on delivery. Recommend
  `TWILIO_ACCOUNT_SID=AC_TEST_DISABLED` in the test env so Twilio's API isn't reached
  at all.
- **PawaPay** (#43): webhook handler only. `/payments/initiate` and `/payout` are
  `EXT` and skipped unless `RUN_PAWAPAY=1`.
- **Broadcast send** — see §3. Never automated.

---

## 2. File structure

```
scripts/
  test-all.ts                  ← the runner (exit code, summary)
  test-sweep.ts                ← standalone residue sweeper
  testkit/
    env.ts                     ← loadEnvLocal(), sb, BASE, JWT_SECRET, RUN_ID
    assert.ts                  ← assert/assertEq/step; collects results, never process.exit()s
    session.ts                 ← customerCookie(), adminCookie(), api() fetch wrapper
    fixtures.ts                ← makeCustomer/Restaurant/MenuItem/Event/Voucher — each auto-tracks
    ledger.ts                  ← track(table,id), teardown(), writeLedger(), sweepPatterns()
  suites/
    unit-opening-hours.ts      (#2)
    unit-phone-and-text.ts     (#4, #10, #12)
    unit-pricing-and-modes.ts  (#3, #5, #6, #7, #8, #9, #13, #14, #15)
    unit-ordering-parser.ts    (#1 — moved from scripts/test-ordering-parser.ts)
    db-vouchers.ts             (#16, #17)
    db-schema-migrations.ts    (#18, #19, #20, #21)
    api-auth-and-profile.ts    (#28, #37 partial)
    api-menu-crud.ts           (#30)
    api-hours-and-open.ts      (#31, #32)
    api-team-and-invites.ts    (#33)
    api-orders.ts              (#23, #29)
    api-ordering-webhook.ts    (#22)
    api-whatsapp-router.ts     (#45–51)
    api-vouchers.ts            (#24, #36)
    api-events.ts              (#34, #35)
    api-vendor-dashboard.ts    (#25)
    api-notifications.ts       (#26, #27, #42, #43)
    api-social.ts              (#38, #39, #40, #41)
    smoke-readonly.ts          (#44)
```

**Migration policy for the ten existing scripts:** leave them in place and working.
Port their bodies into the corresponding `suites/` file (replacing the inline
env-loader/assert with `testkit` imports), then delete the original. Do this
suite-by-suite so a broken port never takes out a test that works today.

**Runner (`test-all.ts`)** — child process per suite via `tsx`, so a suite that calls
`process.exit(1)` or hard-crashes can't take the run down:

```
npx tsx scripts/test-all.ts [--only <glob>] [--skip api|unit|db] [--bail] [--verbose] [--sweep-only]
```

Behaviour:

1. Compute `RUN_ID` (6 hex), export to children.
2. **Pre-sweep** — delete leftovers from prior crashed runs.
3. Preflight: Supabase reachable; `GET ${BASE}/api/auth/me` → 401 means server is up.
   If down, API suites report `SKIPPED` (and the run fails only under `--require-api`).
4. Unit suites in parallel (no shared state). DB + API suites **sequentially** — rate
   limits and shared counters make parallelism a flakiness source, not a speed win.
5. Per-suite line: `✓ api-menu-crud   12 passed  1.8s` /
   `✗ api-events   9 passed, 2 failed  4.1s`.
6. Post-sweep + **residue assertion** (§4) as the final gate.
7. `process.exit(failedSuites === 0 && residue === 0 ? 0 : 1)`.

`package.json`:

```json
"test":         "tsx scripts/test-all.ts",
"test:unit":    "tsx scripts/test-all.ts --only unit-*",
"test:release": "tsx scripts/test-all.ts --require-api",
"test:sweep":   "tsx scripts/test-sweep.ts --all"
```

---

## 3. Not worth automating now

A smaller reliable suite beats a big flaky one. These are deliberately excluded.

| Flow | Why not |
|---|---|
| **Broadcast send** (`/api/broadcasts/[id]/send`) | Sends real WhatsApp to real subscribers. No safe test path. Cover `create`/`preview`/`eligibility`/`computeBroadcastCost` only, never `send`. |
| **PawaPay initiate / payout / status** | Real sandbox deposits with no delete API — permanent residue in a third-party system, plus network flakiness. Env-gate behind `RUN_PAWAPAY=1`, run by hand. The webhook handler (#43) gives most of the value for none of the cost. |
| **Real Twilio delivery + inbound** | Needs a public callback URL and a real number. The synthetic status-callback POST (#42) covers our half of the contract. |
| **Browser UI** — map, cart, checkout, image cropper, admin console | Needs Playwright + a second runner + selector maintenance. Real gap, but out of scope for a suite that has to stay green. Revisit later with **one** smoke path (load `/`, load a restaurant, add to cart), not a UI suite. |
| **Image upload / `imageOptimizer` / storage buckets** | `sharp` + Supabase Storage; slow, and bucket objects are a second residue surface. |
| **Mapbox geocoding** | Third-party, rate-limited, output changes without our code changing. |
| **Admin password login** (`/api/auth/admin-login`) | bcrypt against real `admin_users`. Forging the admin JWT (as `test-vouchers.ts` does) covers everything downstream. Repeated failed logins may also trip lockout logic on a real account. |
| **`/api/admin/cleanup-expired`** | Destructive against live data by design. Any assertion is either a no-op or dangerous. |
| **Assertions on real production content** | e.g. "MeResto has 12 menu items" — breaks whenever the owner edits the menu. Keep #44 to existence + HTTP 200 only. |
| **Concurrency / race conditions** (`tickets_sold` double-book) | The code has a known race window. A test for it would be inherently flaky. Fix the code first, then test. |

---

## 4. Teardown, residue, and crash safety

### Reserved namespace (what makes sweeping possible)

| Kind | Convention |
|---|---|
| Phones | `+999…` — invalid country code, can never be real. Already the de-facto convention. Formalise as `+999<2-digit suite><4-digit seq>`. |
| Restaurant / event / menu names | `__t_<RUN_ID>_<label>__` |
| Voucher codes | `__T_<RUN_ID>_<label>__` |
| Cities | test rows use `Yaoundé` (matches existing scripts) **except** where a subscriber fan-out could trigger — see hazard 1. |

### Three layers of guarantee

**Layer 1 — `try/finally` per suite.** What the current scripts do. Covers assertion
failures and thrown errors.

**Layer 2 — a durable ledger.** `testkit/fixtures.ts` calls `track(table, id)` on
every insert; `ledger.ts` appends to `scripts/.testrun/<RUN_ID>.json` (gitignored)
synchronously as rows are created. `teardown()` deletes in reverse dependency order:

```
order_items → orders
event_reservations → event_ticket_tiers → event_comments → event_likes → events
customer_vouchers → vouchers
team_invitations → restaurant_team → restaurant_hours → menu_items → restaurants
restaurant_ratings, reports, promotions, broadcasts, event_subscriptions
signup_sessions, verification_codes  (by phone)
message_log  (by to_number LIKE '+999%')
audit_log    (by target_id IN <ledger>)
customers    (by phone LIKE '+999%')
```

It also installs `SIGINT` / `SIGTERM` / `uncaughtException` / `unhandledRejection`
handlers that run `teardown()` before exiting.

**Layer 3 — pattern sweep + residue assertion.** `test-sweep.ts` doesn't need the
ledger — it deletes by the reserved-namespace patterns above, optionally
`--older-than 1h` so it can't stomp a concurrent run. The runner calls it **before**
the run (recover from a prior crash) and **after**. Then the final gate counts rows
matching the patterns; **anything > 0 fails the run**. That is the actual guarantee —
not the teardown code, which can itself be buggy, but an independent assertion that
the DB is clean.

**If a suite is SIGKILLed** (`finally` never runs): the child dies, the runner reads
that suite's ledger file and runs teardown on its behalf, then the sweep catches
anything the ledger missed. Worst case — machine loses power mid-insert — the next
run's pre-sweep cleans it, and `npm run test:sweep` does it on demand.

### Hazards that teardown alone does NOT solve

1. **🔴 `POST /api/events/submit` with `event_auto_approve=true` fans out WhatsApp to
   real subscribers** matching the event's `city` + `category`
   (`notifyEventSubscribers`; same in the admin approve route). Deleting the event
   afterwards does not un-send the messages. **Mitigations, all three:** test
   submitters always have `event_auto_approve=false`; the events suite asserts
   `countMatchingSubscribers(city, category) === 0` *before* any approve call and
   aborts if not; test events use a city outside `SUBSCRIPTION_CITIES`. This is the
   single biggest live-data risk in the plan.
2. **🟠 Shared voucher counters.** Any flow that creates a customer through the *API*
   triggers `assignWelcomeVoucher`, bumping the global `BIENVENUE.current_uses`.
   Teardown must restore it (read-modify-write; slightly racy). Preferred: seed
   customers by direct insert, as the existing scripts do, and exercise the welcome
   path in exactly one place with an explicit restore.
3. **🟠 Rate limiters are in-memory per server process** and will bite a full run:
   `order-create` 30/IP/h, `pay-init` 10/IP/h, `rate` 5/session/h, `reports`
   5/session/h, `comment` 20/session/h, `send-code` 5/phone + 20/IP per h,
   `restaurant-signup` 3/whatsapp + 10/IP per h, `whatsapp` 100/phone/min. Rules:
   per-session/per-phone limits get a fresh identity per run (free — we create them
   anyway); per-IP limits get a per-suite budget (the orders suite must stay under 30
   creates). Against a Vercel deployment these counters are per-instance and
   therefore non-deterministic — another reason `--only` matters for reruns.
4. **🟡 `audit_log` and `message_log` are not cleaned by any current script.** They
   are accumulating today. The ledger handles them going forward; the first sweep run
   should be inspected before it deletes historical `+999` rows.
5. **🟡 FK ordering:** the `restaurant_team` owner trigger means a restaurant always
   has at least one team row — team rows must be deleted before the restaurant.
6. **🟡 Migration-dependent statuses** (`cancelled`, `delivered`): keep the existing
   soft-report pattern (⚠ warn, don't fail) so a pre-migration environment doesn't
   produce false red.
7. **⚪ Real fixtures `c1f5f049…` / `854381d6…` are live production rows.** Read-only,
   always. Writing to them would touch `events_submitted_count`, nickname cooldowns,
   voucher claims and promo eligibility — none cleanly reversible.

---

## 5. Size and runtime

| Group | Suites | Assertions | Wall clock |
|---|---|---|---|
| Unit (pure) | 4 | ~95 | ~2 s (parallel) |
| DB | 2 | ~30 | ~8 s |
| API — local server | 12 | ~130 | ~90 s |
| Read-only smoke | 1 | ~6 | ~2 s |
| Sweep + residue gate | — | ~8 | ~4 s |
| **Total** | **19** | **≈ 270** (≈ 110 numbered cases) | **≈ 1 m 45 s** |

Dominant costs: the WhatsApp ordering E2E (~25 s — it polls `signup_sessions` between
steps) and the events lifecycle (~15 s). Against a deployed URL instead of localhost,
add roughly 40–60 s for network latency on ~200 round trips.

`npm run test:unit` alone is **~2 seconds** — worth wiring as a pre-commit or
pre-push hook independently of the full suite.

---

## 6. Build order

Each step lands green before the next.

1. `testkit/` + `test-all.ts` + `test-sweep.ts`, with the four unit suites. Fast,
   zero risk, immediately useful.
2. Port the ten existing scripts into `suites/`. No new coverage, but everything runs
   under one exit code.
3. `db-schema-migrations.ts` — highest post-deploy value per line of code.
4. New API suites, highest-traffic first: menu → hours/open → team → events →
   whatsapp-router → social.

---

## 7. Open questions

- **Run target:** localhost + live Supabase, or the deployed URL? Changes how JWT
  forging and rate-limit handling are set up.
- **First sweep:** delete all existing `+999…` rows outright, or ship a `--dry-run`
  inspection pass first?
