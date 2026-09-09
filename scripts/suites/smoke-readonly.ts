// TEST-PLAN.md §1c #44 — read-only production smoke.
//
// THIS SUITE NEVER WRITES. No fixtures, no ledger, no teardown, no cleanup —
// because there is nothing to clean. It imports neither testkit/fixtures nor
// track(), and the last step asserts mechanically that the ledger stayed
// empty, so "read-only" is checked rather than promised.
//
// It is the only suite meant to be pointed at a DEPLOYED url:
//
//     BASE_URL=https://streetmenu.vercel.app npx tsx scripts/suites/smoke-readonly.ts
//
// The HTTP reads follow BASE_URL; the database reads go to the same Supabase
// project either way, so both halves are meaningful against a deployment.
//
// EXISTENCE, STATUS AND SHAPE ONLY — NEVER EXACT CONTENT. §3 is explicit that
// assertions like "MeResto has 12 menu items" break whenever the owner edits
// their menu, which makes the suite a liability rather than a signal. So the
// menu is asserted non-empty, never counted; averages are asserted numeric,
// never valued; lists are asserted to be arrays, never enumerated. The only
// facts pinned are the ones that should not change: these rows exist, these
// endpoints answer, and these pages render.
//
// A NOTE ON WHAT IS NOT HERE. The plan's wording mentions
// GET /api/restaurants/<id>. That route has no GET handler — the file exports
// only PATCH/POST (prep-time updates) and a GET returns 405. The restaurant
// detail page queries Supabase directly instead, as does the home feed, which
// is why there are no list endpoints to smoke either. The equivalent coverage
// is here as the page render plus the public API surface that does exist.

import { sb, BASE } from '../testkit/env'
import { assert, assertEq, step, finish } from '../testkit/assert'
import { api } from '../testkit/session'
import { tracked } from '../testkit/ledger'

const SUITE = 'smoke-readonly'

// Live production rows. Read-only, always — writing to these would touch
// real order history, nickname cooldowns and publisher trust counters, none
// of it cleanly reversible (§4 hazard 7).
const MERESTO_ID  = '854381d6-e295-4cf0-8522-089b049f626e'
const CUSTOMER_ID = 'c1f5f049-c6cd-4e7d-be64-4c49f6980a77'

async function main(): Promise<void> {
  console.log(`  (target: ${BASE})`)

  await step('#44 the real restaurant fixture still resolves', async () => {
    const { data, error } = await sb.from('restaurants')
      .select('id, name, status, is_active, deleted_at').eq('id', MERESTO_ID).maybeSingle()
    assert(!error, `restaurants read succeeded${error ? ` — ${error.message}` : ''}`)
    const r = data as { name?: string; status?: string; is_active?: boolean; deleted_at?: string | null } | null
    assert(!!r, `restaurant ${MERESTO_ID.slice(0, 8)} exists`)
    assert(!!r?.name, 'it has a name')          // not WHICH name — owners rename
    assertEq(r?.deleted_at, null, 'it is not soft-deleted')
    assert(r?.is_active === true, 'it is active')
    assert(['active', 'approved'].includes(r?.status ?? ''),
      `its status is public-visible (got ${r?.status})`)
  })

  await step('#44 the real customer fixture still resolves', async () => {
    const { data, error } = await sb.from('customers')
      .select('id, name, status, deleted_at').eq('id', CUSTOMER_ID).maybeSingle()
    assert(!error, `customers read succeeded${error ? ` — ${error.message}` : ''}`)
    const c = data as { name?: string; status?: string; deleted_at?: string | null } | null
    assert(!!c, `customer ${CUSTOMER_ID.slice(0, 8)} exists`)
    assertEq(c?.deleted_at, null, 'not soft-deleted')
    assertEq(c?.status, 'active', 'and active')
  })

  await step('#44 the restaurant has a non-empty menu', async () => {
    // Count only. Never the names or prices — the owner edits those.
    const { data, error } = await sb.from('menu_items').select('id').eq('restaurant_id', MERESTO_ID)
    assert(!error, `menu_items read succeeded${error ? ` — ${error.message}` : ''}`)
    assert((data ?? []).length > 0, `the menu has at least one item (${(data ?? []).length})`)
  })

  await step('#44 the public read APIs answer', async () => {
    const openStatus = await api<{ status?: Record<string, { open: boolean; source: string }> }>(
      `/api/restaurants/open-status?ids=${MERESTO_ID}`)
    assertEq(openStatus.status, 200, 'open-status → 200')
    const entry = openStatus.body.status?.[MERESTO_ID]
    assert(!!entry, 'it returns an entry for the restaurant')
    assertEq(typeof entry?.open, 'boolean', 'with a boolean open flag')  // not WHICH value
    assert(typeof entry?.source === 'string', 'and a source')

    const hours = await api<{ hours?: unknown[] }>(`/api/restaurants/${MERESTO_ID}/hours`)
    assertEq(hours.status, 200, 'hours → 200')
    assert(Array.isArray(hours.body.hours), 'and returns an array (possibly empty)')

    const rating = await api<{ average?: number; count?: number }>(`/api/restaurants/${MERESTO_ID}/rating`)
    assertEq(rating.status, 200, 'rating → 200')
    assertEq(typeof rating.body.average, 'number', 'with a numeric average')
    assertEq(typeof rating.body.count, 'number', 'and a numeric count')

    const summary = await api<{ summary?: Record<string, unknown> }>(
      `/api/restaurants/ratings-summary?ids=${MERESTO_ID}`)
    assertEq(summary.status, 200, 'ratings-summary → 200')
    assert(typeof summary.body.summary === 'object' && summary.body.summary !== null,
      'and returns a summary object')

    const promos = await api<{ promotions?: unknown[] }>(
      '/api/promotions/active?city=Yaound%C3%A9&type=restaurant')
    assertEq(promos.status, 200, 'promotions/active → 200')
    assert(Array.isArray(promos.body.promotions), 'and returns an array')

    const me = await api('/api/auth/me')
    assert(me.status > 0 && me.status < 500, `auth/me answers (${me.status}) — the app is up`)
  })

  await step('#44 the public pages render', async () => {
    for (const path of ['/', '/events', `/restaurant/${MERESTO_ID}`]) {
      const r = await api(path)
      assertEq(r.status, 200, `${path} → 200`)
      // Non-trivial HTML, not a blank shell or an error page. Length only —
      // never a content match, which would break on any copy change.
      assert(r.raw.length > 1000, `${path} returned a real page (${r.raw.length} bytes)`)
    }
  })

  await step('#44 the public feed queries return usable shapes', async () => {
    // The home and events feeds read Supabase directly rather than through an
    // API route, so the smoke equivalent is the same query shape they use.
    const { data: rests, error: rErr } = await sb.from('restaurants')
      .select('id')
      .eq('is_active', true)
      .in('status', ['active', 'approved'])
      .is('deleted_at', null)
    assert(!rErr, `the public restaurant filter runs${rErr ? ` — ${rErr.message}` : ''}`)
    assert((rests ?? []).length > 0, `at least one restaurant is publicly visible (${(rests ?? []).length})`)

    const { error: eErr } = await sb.from('events').select('id').eq('is_active', true).limit(5)
    assert(!eErr, `the public events filter runs${eErr ? ` — ${eErr.message}` : ''}`)
    // Deliberately NOT asserting events exist — a quiet week is not a failure.
  })

  await step('#44 this suite wrote nothing', async () => {
    // The point of the whole file. If a future edit adds a fixture call or a
    // track(), this fails — which is the signal that a read-only production
    // smoke has started mutating live data.
    assertEq(tracked().length, 0, 'the ledger recorded no writes — the suite is read-only')
  })

  finish(SUITE)
}

void main()
