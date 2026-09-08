// TEST-PLAN.md §1c #26 (notify-order) and #27 (approve-welcome).
//
// Ported unchanged in what they assert from:
//   scripts/test-notify-order.ts
//   scripts/test-approve-welcome.ts
//
// Both are API + EXT-soft: Twilio 401s locally against the fake creds, and
// that is fine — §1d says assert on orchestration and route responses, never
// on delivery. notify-order's customerNotified/vendorFanoutStatus and
// approve's welcomedOwners are computed from promise settlement, not from
// Twilio's answer, so they are stable without a working provider.
//
// The Twilio attempts write message_log rows. Nothing cleaned those before —
// a baseline run of the two originals left 21 behind (§4 hazard 4). The
// ledger's phone-keyed teardown removes them now.

import { sb } from '../testkit/env'
import { assert, assertEq, step, finish } from '../testkit/assert'
import { api, adminCookie } from '../testkit/session'
import { makeCustomer, makeRestaurant, makeOrder, addTeamMember } from '../testkit/fixtures'
import { teardown } from '../testkit/ledger'

const SUITE = 'api-notifications'

async function main(): Promise<void> {
  try {
    // ── #26 notify-order ───────────────────────────────────────────────────
    // Restaurant carries the owner's phone directly AND an active owner team
    // row on the same number, so the deduper must collapse to one recipient.
    const customer = await makeCustomer({ suiteNo: 26, name: 'Web Customer' })
    const owner    = await makeCustomer({ suiteNo: 26, name: 'Web Owner' })
    const rest     = await makeRestaurant({ ownerId: owner.id, label: 'notify_order', whatsapp: owner.phone })
    await addTeamMember(rest.id, owner.id, 'owner')

    const order = await makeOrder(rest.id, customer, {
      status: 'pending',
      items: [
        { name: 'Ndolé', quantity: 2, price: 2500 },
        { name: 'Eru',   quantity: 1, price: 2000 },
      ],
      total: 7000,
    })

    await step('notify-order for a valid order → ok, both sides attempted', async () => {
      const r = await api<{ ok?: boolean; customerNotified?: boolean; vendorFanoutStatus?: string }>(
        '/api/whatsapp/notify-order', { body: { orderId: order.id } },
      )
      assertEq(r.status, 200, `HTTP 200 (body ${r.raw.slice(0, 200)})`)
      assertEq(r.body.ok, true, 'ok=true')
      // customerNotified is true iff customer_phone existed AND the notify
      // promise resolved. A Twilio 401 still RESOLVES — sendWhatsApp always
      // returns rather than throwing — so this is delivery-independent.
      assertEq(r.body.customerNotified, true, 'customerNotified=true (customer_phone present)')
      assertEq(r.body.vendorFanoutStatus, 'fulfilled', 'vendor fan-out fulfilled (not rejected)')
    })

    await step('notify-order with missing orderId → 400', async () => {
      const r = await api('/api/whatsapp/notify-order', { body: {} })
      assertEq(r.status, 400, 'HTTP 400 for missing orderId')
    })

    await step('notify-order with unknown orderId → 404', async () => {
      const r = await api('/api/whatsapp/notify-order', {
        body: { orderId: '00000000-0000-0000-0000-000000000000' },
      })
      assertEq(r.status, 404, 'HTTP 404 for missing order row')
    })

    // ── #27 approve-welcome ────────────────────────────────────────────────
    const pendingOwner = await makeCustomer({ suiteNo: 27, name: 'Test Owner' })
    const pendingRest  = await makeRestaurant({
      ownerId: pendingOwner.id, label: 'approve_welcome', whatsapp: pendingOwner.phone,
      status: 'pending', isActive: false,
    })
    // Register the owner in restaurant_team too, to exercise the full
    // recipient fan-out rather than just the customer_id path.
    await addTeamMember(pendingRest.id, pendingOwner.id, 'owner')
    const admin = await adminCookie()

    await step('first approve — pending → active, welcome sent', async () => {
      const r = await api<{ ok?: boolean; welcomedOwners?: boolean }>(
        `/api/restaurants/${pendingRest.id}/approve`, { method: 'POST', cookie: admin },
      )
      assertEq(r.status, 200, `HTTP 200 (body ${r.raw.slice(0, 200)})`)
      assertEq(r.body.ok, true, 'ok=true')
      assertEq(r.body.welcomedOwners, true, 'welcomedOwners=true on the transition')

      const { data } = await sb.from('restaurants').select('status').eq('id', pendingRest.id).maybeSingle()
      assertEq((data as { status?: string } | null)?.status, 'active', "restaurants.status = 'active'")
    })

    await step('the transition writes a restaurant_approved audit row', async () => {
      const { data } = await sb.from('audit_log')
        .select('action, target_id, previous_data')
        .eq('target_id', pendingRest.id).eq('action', 'restaurant_approved')
        .order('created_at', { ascending: false }).limit(1).maybeSingle()
      assert(!!data, 'restaurant_approved audit row exists')
      const prev = (data as { previous_data?: { status?: string } } | null)?.previous_data
      assertEq(prev?.status, 'pending', "audit previous_data.status = 'pending'")
    })

    await step('second approve — already active, welcome NOT re-sent', async () => {
      const r = await api<{ ok?: boolean; welcomedOwners?: boolean }>(
        `/api/restaurants/${pendingRest.id}/approve`, { method: 'POST', cookie: admin },
      )
      assertEq(r.status, 200, 'HTTP 200')
      assertEq(r.body.ok, true, 'ok=true')
      assertEq(r.body.welcomedOwners, false, 'welcomedOwners=false on re-approval (no-spam)')
    })

    await step('approve without a session → 401', async () => {
      const r = await api(`/api/restaurants/${pendingRest.id}/approve`, { method: 'POST' })
      assertEq(r.status, 401, 'HTTP 401 for unauthenticated')
    })
  } finally {
    const r = await teardown()
    for (const e of r.errors) console.warn(`  ⚠ teardown: ${e}`)
  }

  finish(SUITE)
}

void main()
