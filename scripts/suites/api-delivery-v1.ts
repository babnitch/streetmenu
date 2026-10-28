// V1 — delivery by the restaurant's own rider, over HTTP.
//
// Settings (/api/restaurants/[id]): on/off, fee, ride time; owner only for
// this restaurant. Orders (/api/orders/create): delivery only when the
// restaurant delivers, address + landmark + phone required, the fee is the
// server's and is added after the voucher (vouchers don't touch the fee).
// The restaurant's new-order WhatsApp carries the address and landmark;
// "delivered" messages the customer for delivery orders only.
//
// Every phone is +999.

import { sb } from '../testkit/env'
import { assert, assertEq, step, finish } from '../testkit/assert'
import { api, customerCookie } from '../testkit/session'
import { makeCustomer, makeRestaurant, makeMenuItem, makeVoucher, makeOrder } from '../testkit/fixtures'
import { teardown, track } from '../testkit/ledger'
import { formatDeliveryTime } from '../../lib/delivery'

const SUITE = 'api-delivery-v1'

interface CreateBody {
  ok?: boolean; reason?: string; total?: number; delivery_fee?: number; error?: string
  order?: { id: string; total_price: number; fulfilment?: string; delivery_fee?: number }
}

async function main(): Promise<void> {
  try {
    const buyer = await makeCustomer({ suiteNo: 67, name: 'Delivery Buyer' })
    const owner = await makeCustomer({ suiteNo: 67, name: 'Delivery Owner' })
    const stranger = await makeCustomer({ suiteNo: 67, name: 'Delivery Stranger' })
    const rest = await makeRestaurant({ ownerId: owner.id, label: 'deliv_r', whatsapp: owner.phone, extra: { prep_time_min: 20, prep_time_max: 30 } })
    const dish = await makeMenuItem(rest.id, { price: 3000 })
    const cookie = customerCookie(buyer)
    const where = { delivery_address: 'Bastos, rue 1.234', delivery_landmark: 'Face à la pharmacie', delivery_phone: buyer.phone }

    const create = (body: Record<string, unknown>) =>
      api<CreateBody>('/api/orders/create', { cookie, body: { restaurant_id: rest.id, order_type: 'reservation', items: [{ id: dish.id, quantity: 2 }], ...body } })
    const settings = (who: typeof owner, body: Record<string, unknown>) =>
      api<{ ok?: boolean; error?: string }>(`/api/restaurants/${rest.id}`, { cookie: customerCookie(who), method: 'PATCH', body })

    await step('delivery is refused while the restaurant has it off', async () => {
      const r = await create({ total_price: 6000, fulfilment: 'delivery', ...where })
      assertEq(r.status, 409, `HTTP 409 (${r.raw.slice(0, 160)})`)
      assertEq(r.body.reason, 'delivery_off', 'reason delivery_off')
    })

    await step('settings: a stranger can\'t, bad values refused, the owner can', async () => {
      assertEq((await settings(stranger, { delivery_enabled: true, delivery_fee: 500 })).status, 403, 'stranger → 403')
      assertEq((await settings(owner, { delivery_enabled: true, delivery_fee: -1 })).status, 400, 'negative fee → 400')
      assertEq((await settings(owner, { delivery_enabled: true, delivery_fee: 500, delivery_extra_min: 999 })).status, 400, 'ride time 999 → 400')
      assertEq((await settings(owner, { delivery_enabled: 'yes', delivery_fee: 500 })).status, 400, 'enabled must be true/false → 400')
      const ok = await settings(owner, { delivery_enabled: true, delivery_fee: 500, delivery_extra_min: 10 })
      assertEq(ok.status, 200, `owner → 200 (${ok.raw.slice(0, 160)})`)
      const { data } = await sb.from('restaurants').select('delivery_enabled, delivery_fee, delivery_extra_min, prep_time_min').eq('id', rest.id).single()
      const row = data as { delivery_enabled: boolean; delivery_fee: number; delivery_extra_min: number; prep_time_min: number }
      assert(row.delivery_enabled === true && row.delivery_fee === 500 && row.delivery_extra_min === 10, 'stored on, 500 FCFA, 10 min')
      assertEq(row.prep_time_min, 20, 'prep time untouched')
    })

    await step('delivery time = prep range + ride', async () => {
      assertEq(formatDeliveryTime(20, 30, 10), '30-40 min', '20-30 + 10 → 30-40 min')
      assertEq(formatDeliveryTime(20, 30, null), '35-45 min', 'no ride time → default 15')
      assertEq(formatDeliveryTime(null, 30, 10), null, 'no prep range → hidden')
    })

    await step('delivery needs address, landmark and phone', async () => {
      const r = await create({ total_price: 6500, fulfilment: 'delivery', delivery_address: 'Bastos', delivery_phone: buyer.phone })
      assertEq(r.status, 400, 'no landmark → 400')
      assertEq(r.body.reason, 'delivery_fields', 'reason delivery_fields')
    })

    await step('a total without the fee is refused, with the fee back', async () => {
      const r = await create({ total_price: 6000, fulfilment: 'delivery', ...where })
      assertEq(r.status, 409, 'HTTP 409')
      assertEq(r.body.reason, 'price_mismatch', 'reason price_mismatch')
      assertEq(r.body.total, 6500, 'server total 6 500')
      assertEq(r.body.delivery_fee, 500, 'fee 500 comes back')
    })

    let deliveryOrderId = ''
    await step('the right total books a delivery order with its address', async () => {
      const r = await create({ total_price: 6500, fulfilment: 'delivery', ...where })
      assertEq(r.status, 200, `HTTP 200 (${r.raw.slice(0, 160)})`)
      if (r.body.order) track('orders', r.body.order.id)
      deliveryOrderId = r.body.order?.id ?? ''
      const { data } = await sb.from('orders').select('total_price, fulfilment, delivery_fee, delivery_address, delivery_landmark, delivery_phone').eq('id', deliveryOrderId).single()
      const o = data as Record<string, unknown>
      assert(Number(o.total_price) === 6500 && o.fulfilment === 'delivery' && Number(o.delivery_fee) === 500, 'stored 6 500, delivery, fee 500')
      assert(o.delivery_address === where.delivery_address && o.delivery_landmark === where.delivery_landmark && o.delivery_phone === buyer.phone, 'stored address, landmark, phone')
    })

    await step('take-away ignores address fields and has no fee', async () => {
      const r = await create({ total_price: 6000, fulfilment: 'pickup', ...where })
      assertEq(r.status, 200, `HTTP 200 (${r.raw.slice(0, 160)})`)
      if (r.body.order) track('orders', r.body.order.id)
      const { data } = await sb.from('orders').select('fulfilment, delivery_fee, delivery_address').eq('id', r.body.order?.id ?? '').single()
      const o = data as Record<string, unknown>
      assert(o.fulfilment === 'pickup' && Number(o.delivery_fee) === 0 && o.delivery_address === null, 'pickup, fee 0, no address')
    })

    await step('the voucher takes nothing off the delivery fee', async () => {
      const v = await makeVoucher({ label: 'deliv50', discountType: 'percent', discountValue: 50, restaurantId: rest.id, extra: { per_customer_max: 0 } })
      // 6 000 food − 50 % = 3 000, + 500 fee = 3 500 (not 3 250).
      const wrong = await create({ total_price: 3250, fulfilment: 'delivery', voucher_code: v.code, ...where })
      assertEq(wrong.body.reason, 'price_mismatch', '50 % off the fee too → refused')
      assertEq(wrong.body.total, 3500, 'server total 3 500')
      const r = await create({ total_price: 3500, fulfilment: 'delivery', voucher_code: v.code, ...where })
      assertEq(r.status, 200, `HTTP 200 (${r.raw.slice(0, 160)})`)
      if (r.body.order) track('orders', r.body.order.id)
    })

    await step('the restaurant\'s new-order WhatsApp has the address and landmark', async () => {
      const r = await api<{ ok?: boolean }>('/api/whatsapp/notify-order', { cookie, body: { orderId: deliveryOrderId } })
      assertEq(r.status, 200, `HTTP 200 (${r.raw.slice(0, 160)})`)
      const { data: logs } = await sb.from('message_log').select('to_number, body')
        .eq('related_id', deliveryOrderId).eq('context', 'order_notification')
      const vendor = (logs ?? []).find(l => String(l.to_number).includes(owner.phone.replace('+', '')))
      assert(!!vendor, 'a message to the restaurant was logged')
      const body = String(vendor?.body ?? '')
      assert(body.includes(where.delivery_address) && body.includes(where.delivery_landmark), 'it carries the address and landmark')
      assert(/LIVRAISON|DELIVERY/.test(body) && body.includes('500'), 'marked delivery, with the fee')
    })

    await step('"delivered" messages the customer for delivery orders only', async () => {
      const { shouldMessageStatus } = await import('../../lib/orderStatusMessages')
      assertEq(await shouldMessageStatus(deliveryOrderId, 'delivered', 'delivery'), true, 'delivery → message')
      assertEq(await shouldMessageStatus(deliveryOrderId, 'delivered', 'pickup'), false, 'take-away → no message')
      // Through the dashboard route: ready → delivered on a delivery order.
      const o = await makeOrder(rest.id, buyer, { status: 'ready', extra: { fulfilment: 'delivery', delivery_address: 'Bastos', delivery_fee: 500 } })
      const r = await api<{ customerNotified?: boolean }>(`/api/orders/${o.id}/status`, { cookie: customerCookie(owner), body: { status: 'delivered' } })
      assertEq(r.status, 200, `HTTP 200 (${r.raw.slice(0, 160)})`)
      assertEq(r.body.customerNotified, true, 'customer told it was delivered')
      const { data: logs } = await sb.from('message_log').select('body').eq('related_id', o.id).eq('context', 'order_status_update')
      assert((logs ?? []).some(l => /livrée|delivered/.test(String(l.body))), 'the message says delivered, not picked up')
    })

    await step('turning delivery off stops delivery orders again', async () => {
      assertEq((await settings(owner, { delivery_enabled: false, delivery_fee: 500 })).status, 200, 'owner turns it off')
      const r = await create({ total_price: 6500, fulfilment: 'delivery', ...where })
      assertEq(r.body.reason, 'delivery_off', 'reason delivery_off')
    })
  } catch (e) {
    assert(false, 'suite crashed', (e as Error).stack)
  } finally {
    await teardown()
  }
  finish(SUITE)
}

void main()
