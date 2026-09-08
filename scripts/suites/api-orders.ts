// TEST-PLAN.md §1c #23 — vendor order status, the full role × transition
// matrix. Ported from scripts/test-vendor-order-actions.ts with the same
// assertions, in the same order.
//
// The one soft spot is #11 (ready → delivered), which depends on
// supabase-orders-cancelled-status.sql having been applied. §4 hazard 6 says
// keep that as a warn rather than a failure so a pre-migration environment
// doesn't go red on correct code. It is a warn() here for exactly that
// reason — everything else is a hard assertion.

import { sb } from '../testkit/env'
import { assert, assertEq, warn, step, finish } from '../testkit/assert'
import { api, customerCookie } from '../testkit/session'
import { makeCustomer, makeRestaurant, makeOrder, addTeamMember, type TestCustomer } from '../testkit/fixtures'
import { teardown } from '../testkit/ledger'

const SUITE = 'api-orders'

interface StatusBody { status?: string; previousStatus?: string; error?: string }

async function main(): Promise<void> {
  try {
    const owner    = await makeCustomer({ suiteNo: 23, name: 'Owner' })
    const manager  = await makeCustomer({ suiteNo: 23, name: 'Manager' })
    const staff    = await makeCustomer({ suiteNo: 23, name: 'Staff' })
    const outsider = await makeCustomer({ suiteNo: 23, name: 'Outsider' })
    const buyer    = await makeCustomer({ suiteNo: 23, name: 'Customer' })

    const rest = await makeRestaurant({ ownerId: owner.id, label: 'vendor_actions', whatsapp: owner.phone })
    // The trigger already made the owner row; upsert the rest on the
    // composite key so it doesn't abort the batch.
    await addTeamMember(rest.id, owner.id,   'owner')
    await addTeamMember(rest.id, manager.id, 'manager')
    await addTeamMember(rest.id, staff.id,   'staff')

    const cookies = {
      owner:    customerCookie(owner),
      manager:  customerCookie(manager),
      staff:    customerCookie(staff),
      outsider: customerCookie(outsider),
    }

    const newOrder = (status = 'pending') => makeOrder(rest.id, buyer as TestCustomer, { status })
    const setStatus = (orderId: string, status: string, cookie: string | null) =>
      api<StatusBody>(`/api/orders/${orderId}/status`, {
        method: 'POST', body: { status }, ...(cookie ? { cookie } : {}),
      })

    // Track the ids the audit-row assertion needs at the end.
    const audited: Record<string, string> = {}

    await step('owner confirms a pending order', async () => {
      const o = await newOrder('pending'); audited.confirmed = o.id
      const r = await setStatus(o.id, 'confirmed', cookies.owner)
      assertEq(r.status, 200, `HTTP 200 (body ${r.raw.slice(0, 160)})`)
      assertEq(r.body.status, 'confirmed', 'new status = confirmed')
      assertEq(r.body.previousStatus, 'pending', 'previousStatus = pending')
    })

    await step('manager moves confirmed → preparing', async () => {
      const o = await newOrder('confirmed'); audited.preparing = o.id
      const r = await setStatus(o.id, 'preparing', cookies.manager)
      assertEq(r.status, 200, `HTTP 200 (body ${r.raw.slice(0, 160)})`)
      assertEq(r.body.status, 'preparing', 'preparing')
    })

    await step('staff moves preparing → ready', async () => {
      const o = await newOrder('preparing'); audited.ready = o.id
      const r = await setStatus(o.id, 'ready', cookies.staff)
      assertEq(r.status, 200, `HTTP 200 (body ${r.raw.slice(0, 160)})`)
      assertEq(r.body.status, 'ready', 'ready')
    })

    await step('staff cannot confirm or cancel', async () => {
      const o1 = await newOrder('pending')
      assertEq((await setStatus(o1.id, 'confirmed', cookies.staff)).status, 403, 'confirm → HTTP 403')
      const o2 = await newOrder('pending')
      assertEq((await setStatus(o2.id, 'cancelled', cookies.staff)).status, 403, 'cancel → HTTP 403')
    })

    await step('owner cancels a pending order', async () => {
      const o = await newOrder('pending'); audited.cancelled = o.id
      const r = await setStatus(o.id, 'cancelled', cookies.owner)
      assertEq(r.status, 200, 'HTTP 200')
      assertEq(r.body.status, 'cancelled', 'cancelled')
    })

    await step('a session with no role on this restaurant → 403', async () => {
      const o = await newOrder('pending')
      assertEq((await setStatus(o.id, 'confirmed', cookies.outsider)).status, 403, 'outsider → HTTP 403')
    })

    await step('no cookie → 401', async () => {
      const o = await newOrder('pending')
      assertEq((await setStatus(o.id, 'confirmed', null)).status, 401, 'unauthenticated → HTTP 401')
    })

    await step('invalid transition (cancelled → preparing) → 409', async () => {
      const o = await newOrder('cancelled')
      assertEq((await setStatus(o.id, 'preparing', cookies.owner)).status, 409, 'HTTP 409')
    })

    await step('unknown target status → 400', async () => {
      const o = await newOrder('pending')
      assertEq((await setStatus(o.id, 'nonsense', cookies.owner)).status, 400, 'HTTP 400')
    })

    await step('ready → delivered (migration-dependent)', async () => {
      const o = await newOrder('ready')
      const r = await setStatus(o.id, 'delivered', cookies.staff)
      if (r.status === 200) {
        assertEq(r.body.status, 'delivered', 'delivered')
      } else if (r.status === 500 && /migration/i.test(r.body.error ?? '')) {
        // §4 hazard 6: a pre-migration environment must not turn this red.
        warn('delivered blocked by a pre-migration constraint',
          'expected until supabase-orders-cancelled-status.sql is applied')
      } else {
        assert(false, `unexpected delivered response: ${r.status} ${r.raw.slice(0, 160)}`)
      }
    })

    await step('every transition wrote its audit row', async () => {
      const ids = [audited.confirmed, audited.preparing, audited.ready, audited.cancelled].filter(Boolean)
      const { data } = await sb.from('audit_log')
        .select('action, target_id')
        .in('action', ['order_confirmed', 'order_preparing', 'order_ready', 'order_cancelled'])
        .in('target_id', ids)
      const actions = new Set((data ?? []).map(a => (a as { action: string }).action))
      for (const a of ['order_confirmed', 'order_preparing', 'order_ready', 'order_cancelled']) {
        assert(actions.has(a), `${a} audit row`)
      }
    })
  } finally {
    const r = await teardown()
    for (const e of r.errors) console.warn(`  ⚠ teardown: ${e}`)
  }

  finish(SUITE)
}

void main()
