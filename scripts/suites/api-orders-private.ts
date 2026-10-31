// Orders are server-only (anon-read fix, #2). The two pages that used to
// read orders with the public key now go through login-checked routes:
//
//   - GET /api/restaurants/[id]/orders (pro dashboard): implicit owner, any
//     active team member and admins; strangers 403, no login 401;
//   - GET /api/admin/orders (Admin → Commandes): admin roles that see the
//     Orders tab (moderators included), with the same filters as before.
//
// Every phone is +999, test city only. Read-only routes: no messages sent.

import { assert, assertEq, step, finish } from '../testkit/assert'
import { api, customerCookie, adminCookie, staffCookie } from '../testkit/session'
import { makeCustomer, makeRestaurant, makeOrder, addTeamMember } from '../testkit/fixtures'
import { teardown, track } from '../testkit/ledger'

const SUITE = 'api-orders-private'

interface OrdersBody { orders?: Array<{ id: string; restaurant_id: string; status: string; restaurants?: { name: string } | null }>; restaurants?: Array<{ id: string }> }

async function main(): Promise<void> {
  try {
    const owner = await makeCustomer({ name: 't_priv_owner' })
    const staff = await makeCustomer({ name: 't_priv_staff' })
    const stranger = await makeCustomer({ name: 't_priv_stranger' })
    const buyer = await makeCustomer({ name: 't_priv_buyer' })
    const rest = await makeRestaurant({ label: 'priv_orders', ownerId: owner.id })
    const other = await makeRestaurant({ label: 'priv_other' })
    track('restaurant_team', await addTeamMember(rest.id, staff.id, 'staff'))
    const mine = await makeOrder(rest.id, buyer, { total: 1500 })
    const done = await makeOrder(rest.id, buyer, { total: 2000, status: 'delivered' })
    const theirs = await makeOrder(other.id, buyer, { total: 900 })

    await step('pro dashboard: owner and staff read their orders; others can\'t', async () => {
      const url = `/api/restaurants/${rest.id}/orders`
      const o = await api<OrdersBody>(url, { cookie: customerCookie(owner) })
      assertEq(o.status, 200, 'implicit owner → 200')
      assertEq((o.body.orders ?? []).map(x => x.id).sort(), [mine.id, done.id].sort(), 'only this restaurant\'s orders')
      assertEq((await api(url, { cookie: customerCookie(staff) })).status, 200, 'staff → 200')
      assertEq((await api(url, { cookie: customerCookie(stranger) })).status, 403, 'stranger → 403')
      assertEq((await api(url)).status, 401, 'no login → 401')
      assertEq((await api(url, { cookie: await adminCookie() })).status, 200, 'admin → 200')
    })

    await step('Admin → Commandes: admins and moderators; filters work', async () => {
      const admin = await adminCookie()
      const all = await api<OrdersBody>(`/api/admin/orders?restaurant=${rest.id}`, { cookie: admin })
      assertEq(all.status, 200, 'admin → 200')
      assertEq((all.body.orders ?? []).length, 2, 'restaurant filter')
      assert(!(all.body.orders ?? []).some(x => x.id === theirs.id), 'another restaurant\'s order left out')
      assert((all.body.orders ?? []).every(x => !!x.restaurants?.name), 'restaurant name joined')
      const delivered = await api<OrdersBody>(`/api/admin/orders?restaurant=${rest.id}&status=delivered`, { cookie: admin })
      assertEq((delivered.body.orders ?? []).map(x => x.id), [done.id], 'status filter')
      const list = await api<OrdersBody>('/api/admin/orders?only=restaurants', { cookie: admin })
      assert((list.body.restaurants ?? []).some(r => r.id === other.id), 'restaurant list for the filter')
      const mod = staffCookie({ id: '00000000-0000-0000-0000-000000000000', email: 'm@test.invalid', name: 'Mod', role: 'moderator' })
      assertEq((await api(`/api/admin/orders?restaurant=${other.id}`, { cookie: mod })).status, 200, 'moderator → 200')
      assertEq((await api('/api/admin/orders', { cookie: customerCookie(owner) })).status, 401, 'customer → 401')
      assertEq((await api('/api/admin/orders')).status, 401, 'no login → 401')
    })
  } catch (e) {
    assert(false, 'suite crashed', (e as Error).stack)
  } finally {
    const r = await teardown()
    for (const e of r.errors) console.warn(`  ⚠ teardown: ${e}`)
  }
  finish(SUITE)
}

void main()
