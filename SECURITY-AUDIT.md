# Security Audit — May 2026

**Audit date:** 2026-05-21
**Scope:** full app — auth, API surface, DB row-level security, third-party webhooks, browser security headers, input handling.
**Performed by:** in-house pre-launch sweep.

This document records what was found, what was fixed in the same pass, what was intentionally deferred, and what we recommend the operator do before turning on production traffic. Updates land here as we close each TODO.

---

## 1. Critical issues — fixed in this audit

### 1.1 Twilio webhook had no signature validation
- **Finding:** `POST /api/whatsapp/incoming` accepted any request to the public URL, so anyone could spoof messages from any phone — including triggering OTPs, placing orders, sending team invitations.
- **Fix:** validate the `X-Twilio-Signature` header using Twilio's HMAC-SHA1 algorithm via the official `twilio` package. Skipped (with a console warning) when `TWILIO_AUTH_TOKEN` isn't set so the dev sandbox keeps working.
- **Operator action:** set `TWILIO_AUTH_TOKEN` and `TWILIO_WEBHOOK_URL` in Vercel prod env vars before launch.

### 1.2 Row Level Security was effectively open
- **Finding:** every table shipped with `CREATE POLICY "service_role_only" ON … USING (false)` but RLS itself wasn't enabled on most tables — so the anon Supabase client could SELECT (and in some cases mutate) every row. Customer vouchers, orders, reservations, even `customers` were readable with a leaked anon key.
- **Fix:** `supabase-rls-policies.sql` flips RLS on for every table and applies two policy shapes:
  - **Public reads** for the genuinely public surfaces: `restaurants` (active + approved), `menu_items` (when parent restaurant is public), `restaurant_hours`, `restaurant_ratings`, `events` (active), `event_likes`, `event_comments` (non-hidden), `event_ticket_tiers`, `vouchers` (active), `broadcast_pricing`, `promotion_pricing`.
  - **Service-role-only** for everything else (`customers`, `admin_users`, `restaurant_team`, `team_invitations`, `orders`, `order_items`, `customer_vouchers`, `event_reservations`, `event_subscriptions`, `broadcasts`, `promotions`, `reports`, `audit_log`, `verification_codes`, `signup_sessions`).
- **Collateral fix:** three client-side queries that were *reading* private tables broke under the new policy and were refactored to API routes that authenticate via our JWT and use `supabaseAdmin`:
  - `GET /api/customer/orders` (replaces `supabase.from('orders')` in `/account`).
  - `GET /api/customer/vouchers/my` (replaces `supabase.from('customer_vouchers')` in `/account` + `/order`).
  - `POST /api/orders/create` (replaces the direct `supabase.from('orders').insert(…)` in `/order` checkout — also gained server-side sanitisation of every field).
  - `POST /api/vendor/vouchers/consume` (replaces direct `customer_vouchers.update` + `vouchers.update` from the dashboard validate-voucher button).
- **Operator action:** run `supabase-rls-policies.sql` in Supabase SQL Editor *after* deploying the new commit. Running it before the deploy will break the live app for the few minutes between the two.

### 1.3 No rate-limiting on OTP / payment / abuse endpoints
- **Finding:** `/api/auth/send-code` was unbounded — an attacker could burn through Twilio credit or harvest OTPs against a victim phone. `/api/payments/initiate`, `/api/reports`, comment + rating endpoints had the same shape.
- **Fix:** `lib/rateLimit.ts` — in-memory sliding-window limiter with per-key buckets. Applied:
  - `send-code` — 5 per phone per hour + 20 per IP per hour
  - `verify-code` — 10 per phone per hour
  - `whatsapp/incoming` — 100 per phone per minute
  - `payments/initiate` — 10 per IP per hour
  - `reports` — 5 per customer per hour
  - `comments` — 20 per customer per hour
  - `rate` (restaurant rating) — 5 per customer per hour
  - `promotions/[id]/impression` — 60 per IP per minute
  - `orders/create` — 30 per IP per hour
- **Known limitation:** Vercel runs each serverless instance in its own memory. An attacker can theoretically multiply the cap by spreading hits across cold-start instances. Acceptable at MVP scale; a Redis-backed limiter (Upstash) is the production upgrade.

### 1.4 Browser security headers were missing
- **Finding:** no CSP, no X-Frame-Options, no Referrer-Policy. The app was iframe-embeddable, CSS could be injected through any future XSS, referrers leaked to third-party origins.
- **Fix:** `next.config.mjs` now sets on every HTML response:
  - `X-Frame-Options: DENY`
  - `X-Content-Type-Options: nosniff`
  - `Referrer-Policy: strict-origin-when-cross-origin`
  - `Permissions-Policy: camera=(self), microphone=(), geolocation=(self), interest-cohort=()`
  - `Content-Security-Policy:` allowing only Supabase, Mapbox, Twilio, PawaPay, self origins. `'unsafe-inline'`/`'unsafe-eval'` on script remain — Next.js needs them for hydration. Nonce-based CSP requires Next 15+ middleware; tracked under "Remaining".

### 1.5 Input sanitisation was inconsistent
- **Finding:** several routes did `.trim()` but not HTML stripping or length capping. Free-text fields (event comments, reports, signup name, voucher code) accepted any payload up to whatever Postgres allowed.
- **Fix:** `lib/sanitize.ts`:
  - `sanitizeText(input, maxLength)` — strips HTML, control chars; collapses whitespace; truncates.
  - `sanitizePhone(input)` — digits + leading `+` only.
  - `sanitizeCode(input, maxLength=32)` — `A-Z0-9_-` uppercased.
  - `sanitizeNickname(input)` — rejects phone-like strings + social handles.
- **Applied to:** WhatsApp `Body`, OTP `code`, signup `name`/`city`, event comments, reports, voucher codes, order `customer_name`/`customer_phone`, every item name on the order checkout payload.

---

## 2. Lower-priority issues — also fixed

### 2.1 WhatsApp media uploads ran without rate-limiting
- Inherits the per-phone `whatsapp:` limiter (100/min). A photo flood is already throttled.

### 2.2 Order `items` JSONB was attacker-controllable
- `/api/orders/create` now whitelists the cart-line keys (`id`, `name`, `price`, `quantity`, `photo_url`). Extra fields are dropped.

### 2.3 Supabase Storage cache headers were the platform default (1h)
- `/api/upload/image` sets `cacheControl='86400'` (24h browser cache). WhatsApp uploads inherit the same.

---

## 3. Authorization audit results

Walked every `POST/PATCH/DELETE` route under `app/api/**/route.ts`.

| Category | Routes audited | Issues |
|---|---:|---|
| Admin actions (`/api/admin/*`, `/api/accounts/[id]/*`) | 19 | All gated on `session && role ∈ {super_admin,admin,moderator}`. ✓ |
| Vendor owner-only actions (restaurant settings, payment, hours, team) | 11 | All check `restaurant_team.role='owner'` for the target restaurant. ✓ |
| Vendor manager/staff actions (orders, menu, vouchers) | 10 | Membership check via `restaurant_team` row with role gate. ✓ |
| Customer self-actions (vouchers/claim, subscriptions, reservations) | 12 | All require `session.role === 'customer'`. ✓ |
| Organizer-only (event settings, tiers, reservations confirm/reject) | 8 | Check `events.organizer_id === session.id` OR admin role. ✓ |
| Payment/webhook endpoints | 4 | Webhook validates RFC-9421 `Content-Digest`. Initiate / status check session for customer ownership. ✓ |

No route was found ungated. The two unauthenticated public endpoints are `/api/whatsapp/incoming` (now signature-validated) and `/api/payments/webhook` (signature-validated since launch).

---

## 4. SQL injection review

All DB access goes through the Supabase JS client (`supabaseAdmin` / `supabase`), which builds parameterized PostgREST queries — there is no string concatenation against user input anywhere in the codebase. The only places we use `.ilike()` with user-controlled patterns are:

- `app/api/whatsapp/incoming/route.ts` `findMenuItem()` — wraps the name in `%…%` for a partial match. PostgREST escapes the value; the LIKE metacharacters (`%`, `_`) embedded in the input only over-broaden the search, which is harmless here.
- `app/api/admin/accounts/route.ts` search — same pattern, admin-only, also safe.

The WhatsApp message parser uses fixed regex shapes (`/^reserver\s+([0-9a-f]{4})$/` etc.) that constrain everything to lowercase ASCII before it reaches the DB.

**No SQL injection vectors found.**

---

## 5. Remaining (acceptable for MVP, tracked for production)

| Item | Risk | Mitigation plan |
|---|---|---|
| In-memory rate limiter | Attacker can spread requests across Vercel cold-start instances and multiply the effective cap. | Migrate to Upstash Redis (`@upstash/ratelimit`) once we cross 1k DAU. Cost ≈ $10/mo. |
| CSP requires `unsafe-inline` + `unsafe-eval` | XSS via Next.js's inline state blob is reachable. | Adopt Next.js 15 middleware nonces. Tracked in ROADMAP Phase 11. |
| Admin password rotation never exercised | Stale `JWT_SECRET` could be reused if leaked. | Schedule a rotation drill; build a "rotate JWT secret" runbook. |
| No DB-level audit on PII reads | Cannot detect if a leaked service-role key reads `customers` rows. | Enable `pg_audit` on `customers` + `orders` + `event_reservations`. |
| Bcrypt at 10 rounds | Acceptable for current login volume; weak vs a future GPU attacker. | Bump to 12 when admin login crosses ~5/min sustained. |
| Sandbox PawaPay webhook bypasses signature check | Useful in dev; risky if `PAWAPAY_ENVIRONMENT=sandbox` leaks into prod. | Treat the env value as a deploy-time invariant; surface it in `/admin` profile. |
| No CSRF tokens on POST routes | We rely on SameSite=Lax cookies + JSON-only POSTs. Sufficient for current browsers; not airtight. | Add per-session CSRF tokens on form submissions; tracked Phase 11. |
| Customer accounts can't be locked after N failed OTP attempts | OTP records are single-use + 10-min TTL, so brute-force is limited but not blocked. | Add per-phone lock after 10 failed verifies; ~half a day of work. |
| Image upload size cap is 20MB | A flood of 20MB uploads costs Vercel egress + sharp CPU. | Tighter cap (5MB) + per-IP upload limiter; one-line change once Redis limiter is in. |
| No audit-log read UI | Support can only inspect actions via direct SQL. | Build `/admin/audit` reader; small project. |

---

## 6. Production launch checklist (operator)

In Vercel project settings → Environment Variables (Production):

- [ ] `TWILIO_AUTH_TOKEN` set (enables webhook signature validation)
- [ ] `TWILIO_WEBHOOK_URL` set to `https://<production-domain>/api/whatsapp/incoming`
- [ ] `PAWAPAY_ENVIRONMENT=production`
- [ ] `PAWAPAY_API_TOKEN` rotated for production
- [ ] `JWT_SECRET` rotated for production (≥32 random bytes)
- [ ] `NEXT_PUBLIC_BASE_URL` matches production domain exactly
- [ ] `SUPABASE_SERVICE_ROLE_KEY` confirmed not present in any public env var

In Supabase:

- [ ] Run `supabase-rls-policies.sql` in production project (after `supabase-image-optimization.sql`).
- [ ] Verify the anon key cannot read `customers`, `orders`, `customer_vouchers` via the Supabase Table Editor's anon-role test.
- [ ] Confirm all 28 prior migrations have been run in order (see `TECHNICAL-REQUIREMENTS.md` §6).

In Twilio:

- [ ] WhatsApp sender out of sandbox.
- [ ] Webhook URL points at production; auth token matches Vercel.

In PawaPay:

- [ ] Production merchant onboarded.
- [ ] Webhook URL `/api/payments/webhook` registered.
- [ ] Webhook signing key matches the `PAWAPAY_*` env vars.

In your team channel:

- [ ] Rate-limit dashboard / log alert on > 5% 429 responses.
- [ ] On-call rotation for the first 30 days.
- [ ] Backup + restore drill on the Supabase DB.

---

## 7. How to use this doc

- New vulnerability → add it to §1 (with fix) or §5 (with mitigation).
- New fix → move the row from §5 to §1 and update its status.
- Pre-launch checks → tick the boxes in §6.
- This doc lives in the repo so PR reviewers can reject changes that revert the listed hardenings.
