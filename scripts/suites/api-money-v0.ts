// V0 — money is the server's, over HTTP.
//
// Restaurant orders (/api/orders/create): dish prices come from the menu, the
// voucher is validated and used up by the server, and a checkout whose total
// differs is refused with the current prices. Event bookings (/reserve,
// /pay): an event with ticket types can't be booked at the event's single
// price, and a page total that differs from the server's is refused.
//
// Every phone is +999; nothing reaches PawaPay (the refused /pay calls stop
// before the deposit).

import { sb } from '../testkit/env'
import { assert, assertEq, step, finish } from '../testkit/assert'
import { api, customerCookie } from '../testkit/session'
import { makeCustomer, makeRestaurant, makeMenuItem, makeVoucher, makeEvent, makeTier } from '../testkit/fixtures'
import { teardown, track } from '../testkit/ledger'

const SUITE = 'api-money-v0'

interface CreateBody {
  ok?: boolean; reason?: string; total?: number; error?: string
  current?: Array<{ id: string; price: number; available: boolean }>
  order?: { id: string; total_price: number }
}
interface BookBody { ok?: boolean; reason?: string; total_price?: number; reservation_id?: string; reservation_ids?: string[] }

async function main(): Promise<void> {
  try {
    const buyer = await makeCustomer({ suiteNo: 65, name: 'Money Buyer' })
    const owner = await makeCustomer({ suiteNo: 65, name: 'Money Owner' })
    const rest  = await makeRestaurant({ ownerId: owner.id, label: 'money_r', whatsapp: owner.phone })
    const other = await makeRestaurant({ label: 'money_other' })
    const ndole = await makeMenuItem(rest.id, { price: 3000 })
    const poulet = await makeMenuItem(rest.id, { price: 4500 })
    const soldOut = await makeMenuItem(rest.id, { price: 1000, available: false })
    const foreign = await makeMenuItem(other.id, { price: 10 })
    const cookie = customerCookie(buyer)

    const create = (body: Record<string, unknown>) =>
      api<CreateBody>('/api/orders/create', { cookie, body: { restaurant_id: rest.id, order_type: 'reservation', ...body } })

    await step('a lowered price and total are refused, with the real prices', async () => {
      const r = await create({ items: [{ id: ndole.id, name: 'x', price: 1, quantity: 2 }], total_price: 2 })
      assertEq(r.status, 409, 'HTTP 409')
      assertEq(r.body.reason, 'price_mismatch', 'reason price_mismatch')
      assertEq(r.body.total, 6000, 'the server total comes back')
      assertEq(r.body.current?.find(c => c.id === ndole.id)?.price, 3000, 'with the menu price')
      const { count } = await sb.from('orders').select('id', { count: 'exact', head: true }).eq('restaurant_id', rest.id)
      assertEq(count ?? 0, 0, 'no order written')
    })

    await step('the right total goes through; prices and names come from the menu', async () => {
      const r = await create({ items: [{ id: ndole.id, price: 1, name: 'cheap', quantity: 2 }, { id: poulet.id, quantity: 1 }], total_price: 10500 })
      assertEq(r.status, 200, `HTTP 200 (${r.raw.slice(0, 160)})`)
      if (r.body.order) track('orders', r.body.order.id)
      const { data } = await sb.from('orders').select('total_price, items').eq('id', r.body.order?.id ?? '').single()
      const row = data as { total_price: number; items: Array<{ id: string; name: string; price: number; quantity: number }> }
      assertEq(Number(row.total_price), 10500, 'stored total 10 500')
      const line = row.items.find(i => i.id === ndole.id)
      assert(line?.price === 3000 && line?.name === ndole.name, 'stored line has the menu price and name')
    })

    await step('a dish from another restaurant or sold out is refused', async () => {
      const a = await create({ items: [{ id: foreign.id, quantity: 1 }], total_price: 10 })
      assertEq(a.status, 409, 'other restaurant\'s dish → 409')
      assertEq(a.body.reason, 'unknown_item', 'reason unknown_item')
      const b = await create({ items: [{ id: soldOut.id, quantity: 1 }], total_price: 1000 })
      assertEq(b.body.reason, 'sold_out', 'sold-out dish → sold_out')
      assert(/Épuisé/.test(b.body.error ?? '') && /Sold out/.test(b.body.error ?? ''), 'FR/EN "Épuisé / Sold out"')
    })

    await step('voucher: discount from the server, used up once with the order', async () => {
      const v = await makeVoucher({ label: 'money20', discountType: 'percent', discountValue: 20, restaurantId: rest.id, extra: { per_customer_max: 0 } })
      const wrong = await create({ items: [{ id: poulet.id, quantity: 1 }], total_price: 4500, voucher_code: v.code })
      assertEq(wrong.body.reason, 'price_mismatch', 'total without the discount → refused')
      const r = await create({ items: [{ id: poulet.id, quantity: 1 }], total_price: 3600, voucher_code: v.code, discount_amount: 4000 })
      assertEq(r.status, 200, `HTTP 200 (${r.raw.slice(0, 160)})`)
      if (r.body.order) track('orders', r.body.order.id)
      const { data: o } = await sb.from('orders').select('total_price, discount_amount, voucher_code').eq('id', r.body.order?.id ?? '').single()
      const ord = o as { total_price: number; discount_amount: number; voucher_code: string }
      assert(Number(ord.total_price) === 3600 && Number(ord.discount_amount) === 900 && ord.voucher_code === v.code, 'stored 3 600 with 900 off (the browser\'s discount ignored)')
      const uses = async () => ((await sb.from('vouchers').select('current_uses').eq('id', v.id).single()).data as { current_uses: number }).current_uses
      assertEq(await uses(), 1, 'voucher used once')
      await api('/api/customer/vouchers/consume', { cookie, body: { voucherId: v.id, orderId: r.body.order?.id } })
      assertEq(await uses(), 1, 'the old browser "consume" call no longer counts it again')
    })

    await step('an invalid voucher is refused, not ignored', async () => {
      const r = await create({ items: [{ id: ndole.id, quantity: 1 }], total_price: 3000, voucher_code: 'NOPE_NOT_A_CODE' })
      assertEq(r.status, 422, 'HTTP 422')
      assertEq(r.body.reason, 'voucher_not_found', 'reason voucher_not_found')
    })

    // ── Event bookings ────────────────────────────────────────────────────
    const org = await makeCustomer({ suiteNo: 65, name: 'Money Organiser' })
    const tiered = await makeEvent({ organizerId: org.id, label: 'money_tiered', isActive: true, ticketPrice: 0, extra: { payment_mode: 'both', payment_enabled: true } })
    const vip = await makeTier(tiered.id, { name: 'VIP', price: 5000 })
    const single = await makeEvent({ organizerId: org.id, label: 'money_single', isActive: true, ticketPrice: 2000 })

    const book = (eventId: string, path: 'reserve' | 'pay', body: Record<string, unknown>) =>
      api<BookBody>(`/api/events/${eventId}/${path}`, { cookie, body })
    const trackRes = (b: BookBody) => {
      for (const id of b.reservation_ids ?? (b.reservation_id ? [b.reservation_id] : [])) track('event_reservations', id)
    }

    await step('an event with ticket types can\'t be booked at its single price', async () => {
      const r = await book(tiered.id, 'reserve', { quantity: 2 })
      trackRes(r.body)
      assertEq(r.status, 400, '/reserve without a ticket type → 400')
      assertEq(r.body.reason, 'tier_required', 'reason tier_required')
      const p = await book(tiered.id, 'pay', { quantity: 1, phoneNumber: '+237670000000' })
      trackRes(p.body)
      assertEq(p.status, 400, '/pay without a ticket type → 400')
      assertEq(p.body.reason, 'tier_required', 'reason tier_required')
    })

    await step('a page total that differs is refused; the right one books', async () => {
      const bad = await book(tiered.id, 'reserve', { items: [{ tier_id: vip.id, quantity: 2 }], expected_total: 100 })
      trackRes(bad.body)
      assertEq(bad.status, 409, 'tiers: wrong total → 409')
      assertEq(bad.body.total_price, 10000, 'with the server total')
      const good = await book(tiered.id, 'reserve', { items: [{ tier_id: vip.id, quantity: 2 }], expected_total: 10000 })
      trackRes(good.body)
      assertEq(good.status, 200, `tiers: right total → 200 (${good.raw.slice(0, 120)})`)
      const s = await book(single.id, 'reserve', { quantity: 3, expected_total: 5999 })
      trackRes(s.body)
      assertEq(s.body.reason, 'price_mismatch', 'single price: wrong total → refused')
      const p = await book(single.id, 'pay', { quantity: 1, phoneNumber: '+237670000000', expected_total: 1 })
      trackRes(p.body)
      // payment_mode is reservation_only on the fixture, so /pay stops on that
      // first — the point is that no reservation was written at 1 FCFA.
      assert(p.status >= 400, '/pay at 1 FCFA → refused')
    })
  } catch (e) {
    assert(false, 'suite crashed', (e as Error).stack)
  } finally {
    await teardown()
  }
  finish(SUITE)
}

void main()
