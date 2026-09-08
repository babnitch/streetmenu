// TEST-PLAN.md §1c #25 — vendor dashboard.
//
// Ported from two scripts, unchanged in what they assert:
//   scripts/test-my-restaurants-and-legacy-owner.ts
//   scripts/test-vendor-restaurants-deleted-filter.ts
//
// Part 1 reproduces the MeResto bug: a restaurant owned via
// restaurants.customer_id with NO restaurant_team row must still appear in
// the dashboard and must still authorise the owner's status transitions.
// Part 2 pins that soft-deleted restaurants never reach the dashboard,
// whichever of the two delete markers is set.
//
// Both originals seeded fixed names (__test_legacy_owner__, __probe_alive__…)
// that the sweeper's reserved-namespace patterns do NOT match, so a crashed
// run left invisible residue. Everything now goes through the fixtures, which
// name rows __t_<RUN_ID>_…__ and track them in the ledger.

import { sb } from '../testkit/env'
import { assert, assertEq, step, finish } from '../testkit/assert'
import { api, customerCookie } from '../testkit/session'
import { makeCustomer, makeRestaurant, makeOrder } from '../testkit/fixtures'
import { teardown } from '../testkit/ledger'

const SUITE = 'api-vendor-dashboard'

interface VendorListBody {
  restaurants?: Array<{ id: string; teamRole?: string }>
  rolesByRestaurantId?: Record<string, string>
}

async function main(): Promise<void> {
  try {
    // ── Part 1: legacy/implicit owner via restaurants.customer_id ──────────
    const owner    = await makeCustomer({ suiteNo: 25, name: 'Legacy Owner' })
    const customer = await makeCustomer({ suiteNo: 25, name: 'Paying Customer' })

    const rest = await makeRestaurant({ ownerId: owner.id, label: 'legacy_owner', whatsapp: owner.phone })

    // Simulate the legacy state: the DB trigger auto-inserts an owner team
    // row, so delete it to exercise the customer_id fallback path.
    await sb.from('restaurant_team').delete().eq('restaurant_id', rest.id)

    const order = await makeOrder(rest.id, customer, { status: 'pending' })
    const ownerCookie = customerCookie(owner)

    await step('pre-condition: no restaurant_team row (legacy shape)', async () => {
      const { data } = await sb.from('restaurant_team').select('*').eq('restaurant_id', rest.id)
      assertEq((data ?? []).length, 0, 'no restaurant_team row for this restaurant')
    })

    await step('GET /api/vendor/restaurants includes the legacy-owned restaurant', async () => {
      const r = await api<VendorListBody>('/api/vendor/restaurants', { cookie: ownerCookie })
      assertEq(r.status, 200, 'HTTP 200')
      const match = (r.body.restaurants ?? []).find(x => x.id === rest.id)
      assert(!!match, 'restaurant appears in list via customer_id fallback')
      assertEq(match?.teamRole, 'owner', 'teamRole=owner for the implicit-owner fallback')
      assertEq(r.body.rolesByRestaurantId?.[rest.id], 'owner', 'rolesByRestaurantId has owner for this restaurant')
    })

    await step('POST /api/orders/[id]/status accepts the legacy owner: pending → confirmed', async () => {
      const r = await api<{ status?: string }>(`/api/orders/${order.id}/status`, {
        cookie: ownerCookie, body: { status: 'confirmed' },
      })
      assertEq(r.status, 200, `HTTP 200 (body ${r.raw.slice(0, 200)})`)
      assertEq(r.body.status, 'confirmed', 'status=confirmed')
    })

    await step('legacy owner can cancel (role-gated action)', async () => {
      const r = await api(`/api/orders/${order.id}/status`, { cookie: ownerCookie, body: { status: 'cancelled' } })
      assertEq(r.status, 200, 'HTTP 200')
    })

    await step('audit row records role=owner for the legacy transition', async () => {
      const { data } = await sb.from('audit_log')
        .select('action, performed_by, previous_data')
        .eq('target_id', order.id).eq('action', 'order_confirmed').limit(1).maybeSingle()
      assert(!!data, 'audit row exists')
      const prev = (data as { previous_data?: { role?: string } } | null)?.previous_data
      assertEq(prev?.role, 'owner', 'previous_data.role=owner')
    })

    // ── Part 2: soft-deleted restaurants never reach the dashboard ─────────
    const multiOwner = await makeCustomer({ suiteNo: 25, name: 'Multi Owner' })
    const alive           = await makeRestaurant({ ownerId: multiOwner.id, label: 'probe_alive',      whatsapp: multiOwner.phone })
    const deletedByColumn = await makeRestaurant({ ownerId: multiOwner.id, label: 'probe_deleted_by', whatsapp: multiOwner.phone,
                                                   extra: { deleted_at: new Date().toISOString() } })
    const deletedByStatus = await makeRestaurant({ ownerId: multiOwner.id, label: 'probe_status_del', whatsapp: multiOwner.phone,
                                                   extra: { status: 'deleted' } })
    const multiCookie = customerCookie(multiOwner)

    await step('GET /api/vendor/restaurants excludes soft-deleted rows', async () => {
      const r = await api<VendorListBody>('/api/vendor/restaurants', { cookie: multiCookie })
      assertEq(r.status, 200, 'HTTP 200')
      const ids = (r.body.restaurants ?? []).map(x => x.id)
      assert(ids.includes(alive.id), 'alive restaurant included')
      assert(!ids.includes(deletedByColumn.id), 'deleted_at=not-null excluded')
      assert(!ids.includes(deletedByStatus.id), "status='deleted' excluded")

      const roles = r.body.rolesByRestaurantId ?? {}
      assertEq(roles[alive.id], 'owner', 'alive has role=owner')
      assertEq(roles[deletedByColumn.id], undefined, 'deleted row has no role entry')
      assertEq(roles[deletedByStatus.id], undefined, 'status-deleted row has no role entry')
    })
  } finally {
    const r = await teardown()
    for (const e of r.errors) console.warn(`  ⚠ teardown: ${e}`)
  }

  finish(SUITE)
}

void main()
