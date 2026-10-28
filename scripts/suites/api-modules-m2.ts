// M2 — Commandes / Paiement / Livraison gates, on the server and in the bot.
//
// Vitrine (no Commandes): no order (web or bot). Commandes without Paiement:
// pay-at-pickup only (paid order, payment start and payment settings
// refused). Commandes without Livraison: no delivery order, delivery can't be
// switched on. Every refusal is 403 reason module_off.
//
// Every phone is +999. The bot runs in a per-run city.

import { sb, testName } from '../testkit/env'
import { assert, assertEq, step, finish } from '../testkit/assert'
import { api, customerCookie } from '../testkit/session'
import { makeCustomer, makeRestaurant, makeMenuItem, makeOrder } from '../testkit/fixtures'
import { teardown, track } from '../testkit/ledger'
import { takesOrders, deliversNow, effectiveRestaurantMode } from '../../lib/modules'

const SUITE = 'api-modules-m2'
const CITY = testName('city')

interface Body { ok?: boolean; reason?: string; error?: string; order?: { id: string } }

const send = (phone: string, body: string) =>
  api('/api/whatsapp/incoming', { form: { From: `whatsapp:${phone}`, Body: body } })

async function main(): Promise<void> {
  try {
    await step('what the modules allow', async () => {
      assertEq(takesOrders({ modules: [] }), false, 'Vitrine takes no orders')
      assertEq(deliversNow({ modules: ['orders'], delivery_enabled: true }), false, 'delivery switch alone is not enough')
      assertEq(deliversNow({ modules: ['orders', 'delivery'], delivery_enabled: true }), true, 'module + switch → delivers')
      assertEq(effectiveRestaurantMode({ modules: ['orders'], payment_mode: 'payment_only' }), 'reservation_only', 'no Paiement → pay at pickup')
      assertEq(effectiveRestaurantMode({ modules: ['orders', 'payment'], payment_mode: 'both' }), 'both', 'with Paiement → its setting')
    })

    const buyer = await makeCustomer({ suiteNo: 72, name: 'M2 Buyer', extra: { city: CITY } })
    const owner = await makeCustomer({ suiteNo: 72, name: 'M2 Owner' })
    const cookie = customerCookie(buyer)
    const vitrine = await makeRestaurant({ label: 'm2_vitrine', city: CITY, modules: [] })
    const basic = await makeRestaurant({ ownerId: owner.id, label: 'm2_basic', city: CITY, whatsapp: owner.phone, modules: ['orders'],
      extra: { delivery_enabled: true, delivery_fee: 500, payment_mode: 'both' } })
    const vDish = await makeMenuItem(vitrine.id, { price: 2000 })
    const bDish = await makeMenuItem(basic.id, { price: 2000 })
    const create = (restaurantId: string, body: Record<string, unknown>) =>
      api<Body>('/api/orders/create', { cookie, body: { restaurant_id: restaurantId, order_type: 'reservation', ...body } })

    await step('Vitrine: no order', async () => {
      const r = await create(vitrine.id, { items: [{ id: vDish.id, quantity: 1 }], total_price: 2000 })
      assertEq(r.status, 403, 'HTTP 403')
      assertEq(r.body.reason, 'module_off', 'reason module_off')
      assert(/Commandes/.test(r.body.error ?? '') && /Orders/.test(r.body.error ?? ''), 'FR/EN names the module')
    })

    await step('Commandes only: pay at pickup works, paying online and delivery don\'t', async () => {
      const ok = await create(basic.id, { items: [{ id: bDish.id, quantity: 1 }], total_price: 2000 })
      assertEq(ok.status, 200, `pay-at-pickup order → 200 (${ok.raw.slice(0, 120)})`)
      if (ok.body.order) track('orders', ok.body.order.id)
      const paid = await create(basic.id, { items: [{ id: bDish.id, quantity: 1 }], total_price: 2000, order_type: 'paid_order' })
      assertEq(paid.status, 403, 'paid order → 403')
      assertEq(paid.body.reason, 'module_off', 'reason module_off')
      const deliv = await create(basic.id, { items: [{ id: bDish.id, quantity: 1 }], total_price: 2500, fulfilment: 'delivery',
        delivery_address: 'Bastos', delivery_landmark: 'Pharmacie', delivery_phone: buyer.phone })
      assertEq(deliv.status, 403, 'delivery order → 403 (switch on, module off)')
      assertEq(deliv.body.reason, 'module_off', 'reason module_off')
    })

    await step('payment start refused without Paiement', async () => {
      const o = await makeOrder(basic.id, buyer, { extra: { order_type: 'paid_order', payment_status: 'pending' } })
      const r = await api<Body>('/api/payments/initiate', { cookie, body: { orderId: o.id, phoneNumber: '+237670000000' } })
      assertEq(r.status, 400, `HTTP 400 (${r.raw.slice(0, 120)})`)
      assert(/Paiement non activé/.test(r.body.error ?? ''), '"Paiement non activé"')
    })

    await step('settings: delivery and online payment need their module', async () => {
      const oc = customerCookie(owner)
      const d = await api<Body>(`/api/restaurants/${basic.id}`, { method: 'PATCH', cookie: oc, body: { delivery_enabled: true, delivery_fee: 500 } })
      assertEq(d.status, 403, 'delivery on → 403')
      const dOff = await api<Body>(`/api/restaurants/${basic.id}`, { method: 'PATCH', cookie: oc, body: { delivery_enabled: false, delivery_fee: 0 } })
      assertEq(dOff.status, 200, 'delivery off → 200 (always allowed)')
      const p = await api<Body>(`/api/restaurants/${basic.id}/payment`, { method: 'PATCH', cookie: oc, body: { payment_mode: 'payment_only' } })
      assertEq(p.status, 403, 'online payment → 403')
      const pOff = await api<Body>(`/api/restaurants/${basic.id}/payment`, { method: 'PATCH', cookie: oc, body: { payment_mode: 'reservation_only' } })
      assertEq(pOff.status, 200, 'pay at pickup → 200')
    })

    await step('bot: "commander" lists only restaurants that take orders', async () => {
      await send(buyer.phone, 'fr')
      await send(buyer.phone, 'commander')
      const { data } = await sb.from('signup_sessions').select('data').eq('phone', buyer.phone).maybeSingle()
      const ids = (((data as { data?: { candidates?: Array<{ id: string }> } } | null)?.data?.candidates) ?? []).map(c => c.id)
      assert(ids.includes(basic.id), 'the Commandes restaurant is listed')
      assert(!ids.includes(vitrine.id), 'the Vitrine restaurant is not')
    })

    await step('bot: a restaurant switched to Vitrine mid-conversation is refused', async () => {
      // The list was sent; the restaurant then loses Commandes.
      const { data } = await sb.from('signup_sessions').select('data').eq('phone', buyer.phone).single()
      const cands = ((data as { data: { candidates: Array<{ id: string }> } }).data.candidates)
      const n = cands.findIndex(c => c.id === basic.id) + 1
      await sb.from('restaurants').update({ modules: [] }).eq('id', basic.id)
      await send(buyer.phone, String(n))
      const { data: after } = await sb.from('signup_sessions').select('phone').eq('phone', buyer.phone)
      assertEq((after ?? []).length, 0, 'session closed')
      const { data: logs } = await sb.from('message_log').select('body').like('to_number', `%${buyer.phone.replace('+', '')}%`)
        .order('created_at', { ascending: false }).limit(1)
      assert(/ne prend pas les commandes ici|doesn't take orders here/.test(String(logs?.[0]?.body ?? '')), 'clear reply sent')
    })
  } catch (e) {
    assert(false, 'suite crashed', (e as Error).stack)
  } finally {
    await teardown()
  }
  finish(SUITE)
}

void main()
