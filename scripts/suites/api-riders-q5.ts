// Q5 — riders (optional). Restaurant setting "Livreurs": not on the app
// (default) or using the app. With the app: the owner/manager adds riders
// (one WhatsApp) and assigns delivery orders (one WhatsApp: order number,
// address, landmark, customer phone, cash — NEVER the customer's secret
// delivery code). A rider sees only their orders and confirms with the
// customer's QR or the secret delivery code (delivered_confirmed_by =
// rider). The order number is not proof: typed by the restaurant on a
// delivery it is recorded as restaurant_manual.
//
// Every phone is +999.

import { sb, testPhone } from '../testkit/env'
import { assert, assertEq, step, finish } from '../testkit/assert'
import { api, customerCookie } from '../testkit/session'
import { makeCustomer, makeRestaurant, makeOrder, addTeamMember } from '../testkit/fixtures'
import { teardown, track } from '../testkit/ledger'
import { deliveryCode, ensureScanToken } from '../../lib/scanTokens'

const SUITE = 'api-riders-q5'

interface Body { ok?: boolean; error?: string; riders?: Array<{ id: string; phone: string; customer_id: string; name: string }>; rider?: boolean; orders?: Array<{ id: string }>; token?: string; access?: string; action?: string }

async function lastTo(phone: string, relatedId?: string): Promise<string[]> {
  let q = sb.from('message_log').select('body').like('to_number', `%${phone.replace('+', '')}%`)
  if (relatedId) q = q.eq('related_id', relatedId)
  return ((await q).data ?? []).map(m => String(m.body))
}

async function main(): Promise<void> {
  try {
    const owner = await makeCustomer({ suiteNo: 88, name: 'Q5 Owner', extra: { default_mode: 'pro' } })
    const staffer = await makeCustomer({ suiteNo: 88, name: 'Q5 Staff', extra: { default_mode: 'pro' } })
    const buyer = await makeCustomer({ suiteNo: 88, name: 'Q5 Buyer' })
    const oc = customerCookie(owner)
    const rest = await makeRestaurant({ ownerId: owner.id, label: 'q5_r' })
    await addTeamMember(rest.id, staffer.id, 'staff')
    const riderPhone = testPhone(88, 9101)
    let rider = { id: '', customer_id: '', cookie: '' }
    const delivery = (status = 'ready') => makeOrder(rest.id, buyer, {
      status, total: 4500, extra: { fulfilment: 'delivery', delivery_address: 'Rue 1.234, Bastos', delivery_landmark: 'Près de la pharmacie', delivery_fee: 500 },
    })

    await step('setting: riders need "Mes livreurs utilisent l\'app"', async () => {
      assertEq((await api<Body>(`/api/restaurants/${rest.id}/riders`, { cookie: oc, body: { phone: riderPhone } })).status, 409, 'mode none → 409')
      assertEq((await api(`/api/restaurants/${rest.id}`, { method: 'PATCH', cookie: oc, body: { riders_mode: 'bikes' } })).status, 400, 'bad value → 400')
      assertEq((await api(`/api/restaurants/${rest.id}`, { method: 'PATCH', cookie: oc, body: { riders_mode: 'app' } })).status, 200, 'app → 200')
    })

    await step('owner adds a rider: one WhatsApp; staff and strangers can\'t', async () => {
      assertEq((await api(`/api/restaurants/${rest.id}/riders`, { cookie: customerCookie(staffer), body: { phone: testPhone(88, 9102) } })).status, 403, 'staff → 403')
      const r = await api<Body>(`/api/restaurants/${rest.id}/riders`, { cookie: oc, body: { phone: riderPhone, name: 'Jean Rider' } })
      assertEq(r.status, 200, `added (${r.raw.slice(0, 80)})`)
      const row = r.body.riders!.find(x => x.phone === riderPhone)!
      rider = { id: row.id, customer_id: row.customer_id, cookie: customerCookie({ id: row.customer_id, phone: riderPhone, name: 'Jean Rider' } as never) }
      track('customers', rider.customer_id)
      await sb.from('customers').update({ default_mode: 'pro' }).eq('id', rider.customer_id)   // riders deliver in Pro mode
      const msgs = await lastTo(riderPhone)
      assertEq(msgs.length, 1, 'one WhatsApp')
      assert(msgs[0].includes('/livraisons'), 'with "Mes livraisons" link')
    })

    let o1 = ''
    await step('assign: the rider gets the order, not the secret delivery code', async () => {
      o1 = (await delivery()).id
      const r = await api(`/api/orders/${o1}/rider`, { cookie: oc, body: { rider_id: rider.id } })
      assertEq(r.status, 200, `assigned (${r.raw.slice(0, 60)})`)
      const m = (await lastTo(riderPhone, o1))[0] ?? ''
      assert(m.includes(`#${o1.replace(/-/g, '').slice(-4).toUpperCase()}`), 'order number')
      assert(m.includes('Rue 1.234, Bastos') && m.includes('pharmacie') && m.includes(buyer.phone), 'address, landmark, phone')
      assert(/4\s500\sFCFA/.test(m), 'cash to collect')
      assert(!m.includes(deliveryCode(o1)), 'NOT the secret delivery code')
      assertEq((await api(`/api/orders/${o1}/rider`, { cookie: customerCookie(staffer), body: { rider_id: null } })).status, 403, 'staff can\'t reassign')
    })

    await step('the rider sees only their orders, and nothing of the restaurant', async () => {
      const unassigned = await delivery()
      const r = await api<Body>('/api/rider/orders', { cookie: rider.cookie })
      assertEq(r.body.rider, true, 'is a rider')
      assertEq(r.body.orders?.map(o => o.id), [o1], 'only the assigned order')
      assertEq((await api<Body>(`/api/scan/${await ensureScanToken('order', unassigned.id)}`, { cookie: rider.cookie })).body.access, 'none', 'another order\'s QR → nothing')
      assertEq((await api(`/api/restaurants/${rest.id}/riders`, { cookie: rider.cookie })).status, 403, 'riders list → 403')
      assertEq((await api(`/api/orders/${o1}/status`, { cookie: rider.cookie, body: { status: 'cancelled' } })).status, 403, 'order status → 403')
      assertEq((await api(`/api/restaurants/${rest.id}/menu-files/upload-url`, { cookie: rider.cookie, body: { contentType: 'image/png', bytes: 10 } })).status, 403, 'menu → 403')
    })

    await step('out for delivery: the customer gets the secret code; the rider confirms with it', async () => {
      await api(`/api/orders/${o1}/status`, { cookie: oc, body: { status: 'out_for_delivery' } })
      const code = deliveryCode(o1)
      // P1a: sent, but the message log keeps the code masked.
      const logged = await lastTo(buyer.phone, o1)
      assert(logged.some(m => m.includes('*••••*')) && !logged.some(m => m.includes(code)), 'customer has the code (masked in the log)')
      const orderNo = o1.replace(/-/g, '').slice(-4)
      assertEq((await api(`/api/rider/orders/${o1}/deliver`, { cookie: rider.cookie, body: { code: orderNo } })).status, 400, 'the order number is not the code')
      assertEq((await api(`/api/rider/orders/${o1}/deliver`, { cookie: customerCookie(staffer), body: { code } })).status, 404, 'not their delivery → 404')
      assertEq((await api(`/api/rider/orders/${o1}/deliver`, { cookie: rider.cookie, body: { code } })).status, 200, 'delivered')
      const { data } = await sb.from('orders').select('status, delivered_confirmed_by, delivered_by_rider').eq('id', o1).single()
      assertEq([data!.status, data!.delivered_confirmed_by, data!.delivered_by_rider], ['delivered', 'rider', rider.id], 'recorded: rider')
    })

    await step('the rider scans the customer\'s QR instead', async () => {
      const o2 = (await delivery()).id
      await api(`/api/orders/${o2}/rider`, { cookie: oc, body: { rider_id: rider.id } })
      const t = await ensureScanToken('order', o2)
      const v = await api<Body>(`/api/scan/${t}`, { cookie: rider.cookie })
      assertEq([v.body.access, v.body.action], ['staff', 'handover'], 'button for the rider')
      assertEq((await api(`/api/scan/${t}`, { method: 'POST', cookie: rider.cookie, body: {} })).status, 200, 'delivered')
      const { data } = await sb.from('orders').select('delivered_confirmed_by, delivered_by_rider').eq('id', o2).single()
      assertEq([data!.delivered_confirmed_by, data!.delivered_by_rider], ['rider', rider.id], 'recorded: rider')
    })

    await step('restaurant types the code the rider phones in: secret → restaurant_code; order number → restaurant_manual', async () => {
      const o3 = (await delivery('out_for_delivery')).id
      const c = await api<Body>('/api/scan/code', { cookie: oc, body: { restaurant_id: rest.id, code: deliveryCode(o3) } })
      assertEq(c.status, 200, 'found by the delivery code')
      assertEq((await api(`/api/scan/${c.body.token}`, { method: 'POST', cookie: oc, body: { via: 'code', code: deliveryCode(o3) } })).status, 200, 'delivered')
      const { data: d3 } = await sb.from('orders').select('delivered_confirmed_by').eq('id', o3).single()
      assertEq(d3!.delivered_confirmed_by, 'restaurant_code', 'restaurant_code')

      const o4 = (await delivery('out_for_delivery')).id
      const no = o4.replace(/-/g, '').slice(-4).toUpperCase()
      const c4 = await api<Body>('/api/scan/code', { cookie: oc, body: { restaurant_id: rest.id, code: no } })
      assertEq((await api(`/api/scan/${c4.body.token}`, { method: 'POST', cookie: oc, body: { via: 'code', code: no } })).status, 200, 'handed over')
      const { data: d4 } = await sb.from('orders').select('delivered_confirmed_by').eq('id', o4).single()
      assertEq(d4!.delivered_confirmed_by, 'restaurant_manual', 'only restaurant_manual')
    })

    await step('removing a rider clears their open deliveries and their access', async () => {
      const o5 = (await delivery()).id
      await api(`/api/orders/${o5}/rider`, { cookie: oc, body: { rider_id: rider.id } })
      assertEq((await api(`/api/restaurants/${rest.id}/riders`, { method: 'DELETE', cookie: oc, body: { rider_id: rider.id } })).status, 200, 'removed')
      const { data } = await sb.from('orders').select('rider_id').eq('id', o5).single()
      assertEq(data!.rider_id, null, 'unassigned')
      assertEq((await api<Body>('/api/rider/orders', { cookie: rider.cookie })).body.rider, false, 'no longer a rider')
    })
  } catch (e) {
    assert(false, 'suite crashed', (e as Error).stack)
  } finally {
    await teardown()
  }
  finish(SUITE)
}

void main()
