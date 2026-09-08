// TEST-PLAN.md §1c #22 — the WhatsApp ordering flow end to end.
// Ported from scripts/test-ordering-e2e.ts.
//
// One expectation updated, ruled on before porting (B-2). The original went
// `ok XXXX` → `pret XXXX` and expected confirmed → ready. The vendor
// lifecycle has since gained a `preparer` step, and
// lib/whatsapp/ordering.ts:2986-2991 is strict about it:
//
//     confirmed: ['pending'], preparing: ['confirmed'],
//     ready:     ['preparing'], delivered: ['ready']
//
// with the comment "each verb only progresses one step … forces a paid_order
// through the confirm gate". So `pret` from `confirmed` is correctly refused.
// The suite now walks the real chain — ok → preparer → pret — which restores
// the original coverage and adds the new step.
//
// The webhook is a plain form-POST; only the OUTBOUND Twilio leg needs
// credentials, and that fails harmlessly against +999 numbers. Everything
// asserted here is a DB effect (§1d).

import { sb } from '../testkit/env'
import { assert, assertEq, warn, step, finish } from '../testkit/assert'
import { api } from '../testkit/session'
import { makeCustomer, makeRestaurant, makeMenuItem } from '../testkit/fixtures'
import { teardown } from '../testkit/ledger'

const SUITE = 'api-ordering-webhook'

async function send(from: string, body: string) {
  return api('/api/whatsapp/incoming', { form: { From: `whatsapp:${from}`, Body: body } })
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

async function waitForSession(phone: string, expectedStep: number, timeoutMs = 5000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { data } = await sb.from('signup_sessions').select('*').eq('phone', phone).maybeSingle()
    if (data && (data as { step: number }).step === expectedStep) return data as Record<string, unknown>
    await sleep(150)
  }
  throw new Error(`session did not reach step ${expectedStep}`)
}

interface OrderRow { id: string; status: string; total_price: number }

async function waitForOrder(customerId: string, expectedStatus: string, timeoutMs = 6000): Promise<OrderRow> {
  const deadline = Date.now() + timeoutMs
  let latest: OrderRow | null = null
  while (Date.now() < deadline) {
    const { data } = await sb.from('orders').select('id, status, total_price')
      .eq('customer_id', customerId).order('created_at', { ascending: false }).limit(1).maybeSingle()
    latest = data as OrderRow | null
    if (latest && latest.status === expectedStatus) return latest
    await sleep(150)
  }
  throw new Error(`order did not reach status '${expectedStatus}'; latest=${JSON.stringify(latest)}`)
}

async function main(): Promise<void> {
  try {
    const customer = await makeCustomer({ suiteNo: 22, name: 'WA Customer' })
    const vendor   = await makeCustomer({ suiteNo: 22, name: 'WA Vendor' })
    const rest = await makeRestaurant({ ownerId: vendor.id, label: 'ordering_restaurant', whatsapp: vendor.phone })

    // Menu is read back alphabetically, so Eru (2000) sorts before Ndolé (2500).
    await makeMenuItem(rest.id, { name: 'Ndolé', price: 2500 })
    await makeMenuItem(rest.id, { name: 'Eru',   price: 2000 })

    // Any stray session on these numbers would derail step 1.
    await sb.from('signup_sessions').delete().in('phone', [customer.phone, vendor.phone])

    const EXPECTED_TOTAL = 2 * 2000 + 1 * 2500  // "1 x2, 2 x1" → 2×Eru + 1×Ndolé
    let ourIndex = -1

    await step('customer: "commander" opens a step-1 session with candidates', async () => {
      await send(customer.phone, 'commander')
      const s = await waitForSession(customer.phone, 1)
      const candidates = (s.data as { candidates: Array<{ id: string }> }).candidates
      assert(Array.isArray(candidates) && candidates.length > 0, 'candidates populated')
      ourIndex = candidates.findIndex(c => c.id === rest.id)
      assert(ourIndex >= 0, 'the test restaurant appears in the list')
    })

    await step('customer: picking the restaurant number snapshots its menu', async () => {
      await send(customer.phone, String(ourIndex + 1))
      const s = await waitForSession(customer.phone, 2)
      const d = s.data as { restaurant_id: string; menu: Array<{ menu_item_id: string }> }
      assertEq(d.restaurant_id, rest.id, 'session restaurant_id correct')
      assertEq(d.menu.length, 2, 'menu snapshot has 2 items')
    })

    await step('customer: an order line builds the summary', async () => {
      await send(customer.phone, '1 x2, 2 x1')
      const s = await waitForSession(customer.phone, 3)
      const d = s.data as { total: number; items: Array<{ quantity: number }> }
      assertEq(d.total, EXPECTED_TOTAL, `total is ${EXPECTED_TOTAL}`)
      assertEq(d.items.length, 2, 'two line items')
    })

    let orderId = ''
    let last4 = ''
    await step('customer: "oui" creates the order and clears the session', async () => {
      await send(customer.phone, 'oui')
      const order = await waitForOrder(customer.id, 'pending')
      orderId = order.id
      last4 = order.id.replace(/-/g, '').slice(-4)
      assertEq(order.total_price, EXPECTED_TOTAL, `order total_price=${EXPECTED_TOTAL}`)

      const { data: items } = await sb.from('order_items').select('*').eq('order_id', order.id)
      assertEq((items ?? []).length, 2, 'order_items has 2 rows')

      const { data: session } = await sb.from('signup_sessions').select('*').eq('phone', customer.phone).maybeSingle()
      assert(!session, 'ordering session cleared after order creation')
    })

    // The vendor lifecycle is ok → preparer → pret → recupere. Each verb
    // advances exactly one step; see the header note.
    await step('vendor: "ok" moves pending → confirmed', async () => {
      await send(vendor.phone, `ok ${last4}`)
      const o = await waitForOrder(customer.id, 'confirmed')
      assertEq(o.id, orderId, 'same order row')
    })

    await step('vendor: "preparer" moves confirmed → preparing', async () => {
      await send(vendor.phone, `preparer ${last4}`)
      const o = await waitForOrder(customer.id, 'preparing')
      assertEq(o.id, orderId, 'same order row')
    })

    await step('vendor: "pret" moves preparing → ready', async () => {
      await send(vendor.phone, `pret ${last4}`)
      const o = await waitForOrder(customer.id, 'ready')
      assertEq(o.id, orderId, 'same order row')
    })

    await step('customer: "mes commandes" is a read — no DB change', async () => {
      const before = await sb.from('orders').select('status').eq('id', orderId).maybeSingle()
      const r = await send(customer.phone, 'mes commandes')
      assertEq(r.status, 200, 'webhook accepted the message')
      const after = await sb.from('orders').select('status').eq('id', orderId).maybeSingle()
      assertEq((after.data as { status?: string } | null)?.status,
        (before.data as { status?: string } | null)?.status, 'order status unchanged')
    })

    await step('vendor: "annuler" on a second order (migration-dependent)', async () => {
      // Place a second order through the same flow.
      await send(customer.phone, 'commander')
      const s1 = await waitForSession(customer.phone, 1)
      const cand = (s1.data as { candidates: Array<{ id: string }> }).candidates
      const idx = cand.findIndex(c => c.id === rest.id)
      assert(idx >= 0, 'restaurant still listed for the second order')
      await send(customer.phone, String(idx + 1))
      await waitForSession(customer.phone, 2)
      await send(customer.phone, '1 x1')
      await waitForSession(customer.phone, 3)
      await send(customer.phone, 'oui')
      const order2 = await waitForOrder(customer.id, 'pending')
      const last4b = order2.id.replace(/-/g, '').slice(-4)

      await send(vendor.phone, `annuler ${last4b}`)
      try {
        await waitForOrder(customer.id, 'cancelled', 4000)
        assert(true, 'cancel took effect — the cancelled-status migration is applied')
      } catch {
        // §4 hazard 6: a pre-migration environment must not turn this red.
        const { data } = await sb.from('orders').select('status').eq('id', order2.id).maybeSingle()
        warn('cancel did not take effect',
          `status=${(data as { status?: string } | null)?.status} — expected before supabase-orders-cancelled-status.sql is applied`)
      }
    })
  } finally {
    // The webhook writes sessions keyed by phone; teardown's phone-keyed pass
    // clears them along with the message_log rows Twilio attempts leave.
    const r = await teardown()
    for (const e of r.errors) console.warn(`  ⚠ teardown: ${e}`)
  }

  finish(SUITE)
}

void main()
