// V2 — offer of the day, over HTTP.
//
// Dashboard API (/api/restaurants/[id]/offers): owner/manager only, a price
// below the menu price, no past start, no overlap. Public read
// (/api/offers/today). Pricing (/api/orders/create): today's offer price is
// the price charged, a future or ended offer is not, free delivery makes the
// fee 0. Days are the restaurant's own.
//
// Every phone is +999. menu_offers rows go with their restaurant (cascade).

import { sb } from '../testkit/env'
import { assert, assertEq, step, finish } from '../testkit/assert'
import { api, customerCookie } from '../testkit/session'
import { makeCustomer, makeRestaurant, makeMenuItem } from '../testkit/fixtures'
import { teardown, track } from '../testkit/ledger'
import { dateInZone, addDaysISO, validateOffer, percentOffLabel } from '../../lib/offers'
import { loadRestaurantOffersToday } from '../../lib/offersServer'

const SUITE = 'api-offers-v2'

interface CreateBody {
  ok?: boolean; reason?: string; total?: number; delivery_fee?: number; error?: string
  current?: Array<{ id: string; price: number }>
  order?: { id: string }
}

async function main(): Promise<void> {
  try {
    await step('rules: days by zone, price below the menu, no past start, 60 days at most', async () => {
      const at = new Date('2026-10-28T23:30:00Z')
      assertEq(dateInZone('Africa/Douala', at), '2026-10-29', '23:30 UTC is already the 29th in Douala')
      assertEq(dateInZone('Africa/Abidjan', at), '2026-10-28', 'still the 28th in Abidjan')
      const t = '2026-10-28'
      assert(validateOffer({ kind: 'price', menu_item_id: 'x', offer_price: 2400 }, t, 3000).ok, '2 400 < 3 000 → ok (today by default)')
      assert(!validateOffer({ kind: 'price', menu_item_id: 'x', offer_price: 3000 }, t, 3000).ok, 'equal to the menu price → refused')
      assert(!validateOffer({ kind: 'price', menu_item_id: 'x', offer_price: 2000, starts_on: '2026-10-27' }, t, 3000).ok, 'past start → refused')
      assert(!validateOffer({ kind: 'free_delivery', starts_on: t, ends_on: addDaysISO(t, 61) }, t).ok, '61 days → refused')
      assertEq(percentOffLabel(3000, 2400), '−20 %', 'badge −20 %')
    })

    const owner = await makeCustomer({ suiteNo: 68, name: 'Offer Owner' })
    const buyer = await makeCustomer({ suiteNo: 68, name: 'Offer Buyer' })
    const stranger = await makeCustomer({ suiteNo: 68, name: 'Offer Stranger' })
    const rest = await makeRestaurant({ ownerId: owner.id, label: 'offer_r', whatsapp: owner.phone, extra: { timezone: 'Africa/Douala' } })
    const ndole = await makeMenuItem(rest.id, { price: 3000 })
    const eru = await makeMenuItem(rest.id, { price: 2000 })
    const today = dateInZone('Africa/Douala')
    const ownerCookie = customerCookie(owner)
    const buyerCookie = customerCookie(buyer)

    const offersApi = (cookie: string, body?: Record<string, unknown>) =>
      api<{ ok?: boolean; error?: string; offer?: { id: string }; offers?: Array<{ id: string }>; today?: string }>(
        `/api/restaurants/${rest.id}/offers`, body ? { cookie, body } : { cookie })
    const create = (body: Record<string, unknown>) =>
      api<CreateBody>('/api/orders/create', { cookie: buyerCookie, body: { restaurant_id: rest.id, order_type: 'reservation', ...body } })

    let ndoleOfferId = ''
    await step('dashboard API: a stranger can\'t; the owner publishes a dish offer for today', async () => {
      assertEq((await offersApi(customerCookie(stranger), { kind: 'price', menu_item_id: ndole.id, offer_price: 2400 })).status, 403, 'stranger → 403')
      assertEq((await offersApi(ownerCookie, { kind: 'price', menu_item_id: ndole.id, offer_price: 3500 })).status, 400, 'above the menu price → 400')
      const r = await offersApi(ownerCookie, { kind: 'price', menu_item_id: ndole.id, offer_price: 2400 })
      assertEq(r.status, 200, `owner → 200 (${r.raw.slice(0, 160)})`)
      ndoleOfferId = r.body.offer?.id ?? ''
      const again = await offersApi(ownerCookie, { kind: 'price', menu_item_id: ndole.id, offer_price: 2000, starts_on: today, ends_on: addDaysISO(today, 2) })
      assertEq(again.status, 409, 'overlapping offer on the same dish → 409')
      const list = await offersApi(ownerCookie)
      assertEq(list.body.today, today, 'list says today in Douala')
      assert((list.body.offers ?? []).some(o => o.id === ndoleOfferId), 'the offer is listed')
    })

    await step('public read: today\'s offer price', async () => {
      const r = await api<{ prices?: Record<string, number>; free_delivery?: boolean }>(`/api/offers/today?restaurant_id=${rest.id}`)
      assertEq(r.status, 200, 'HTTP 200')
      assertEq(r.body.prices?.[ndole.id], 2400, 'ndolé at 2 400')
      assertEq(r.body.prices?.[eru.id], undefined, 'eru not on offer')
      assertEq(r.body.free_delivery, false, 'no free delivery')
    })

    await step('the order is charged the offer price; the menu price is refused', async () => {
      const old = await create({ items: [{ id: ndole.id, quantity: 2 }], total_price: 6000 })
      assertEq(old.status, 409, 'menu-price total → 409')
      assertEq(old.body.total, 4800, 'server total 4 800')
      assertEq(old.body.current?.find(c => c.id === ndole.id)?.price, 2400, 'current price is the offer')
      const r = await create({ items: [{ id: ndole.id, quantity: 2 }, { id: eru.id, quantity: 1 }], total_price: 6800 })
      assertEq(r.status, 200, `HTTP 200 (${r.raw.slice(0, 160)})`)
      if (r.body.order) track('orders', r.body.order.id)
      const { data } = await sb.from('orders').select('items').eq('id', r.body.order?.id ?? '').single()
      const line = (data as { items: Array<{ id: string; price: number; regular_price?: number }> }).items.find(i => i.id === ndole.id)
      assert(line?.price === 2400 && line?.regular_price === 3000, 'stored at 2 400 with the menu price 3 000 kept')
    })

    await step('an offer starting tomorrow, or one that ended, is not today\'s price', async () => {
      const tomorrow = await offersApi(ownerCookie, { kind: 'price', menu_item_id: eru.id, offer_price: 1500, starts_on: addDaysISO(today, 1), ends_on: addDaysISO(today, 1) })
      assertEq(tomorrow.status, 200, `tomorrow's offer accepted (${tomorrow.raw.slice(0, 120)})`)
      // An offer that ended yesterday (written directly; the API refuses past dates).
      const { error } = await sb.from('menu_offers').insert({
        restaurant_id: rest.id, menu_item_id: eru.id, kind: 'price', offer_price: 1000,
        starts_on: addDaysISO(today, -3), ends_on: addDaysISO(today, -1),
      })
      assert(!error, `ended offer inserted (${error?.message ?? ''})`)
      const t = await loadRestaurantOffersToday(rest.id)
      assertEq(t.prices[eru.id], undefined, 'eru keeps its menu price today')
      const r = await create({ items: [{ id: eru.id, quantity: 1 }], total_price: 2000 })
      assertEq(r.status, 200, 'eru charged 2 000')
      if (r.body.order) track('orders', r.body.order.id)
      const past = await offersApi(ownerCookie, { kind: 'price', menu_item_id: eru.id, offer_price: 1500, starts_on: addDaysISO(today, -1) })
      assertEq(past.status, 400, 'a past start → 400')
    })

    await step('free delivery: needs delivery on, then the fee is 0', async () => {
      const off = await offersApi(ownerCookie, { kind: 'free_delivery' })
      assertEq(off.status, 409, 'delivery off → 409')
      await sb.from('restaurants').update({ delivery_enabled: true, delivery_fee: 700 }).eq('id', rest.id)
      const r = await offersApi(ownerCookie, { kind: 'free_delivery' })
      assertEq(r.status, 200, `free delivery today → 200 (${r.raw.slice(0, 160)})`)
      const where = { fulfilment: 'delivery', delivery_address: 'Bastos', delivery_landmark: 'Pharmacie', delivery_phone: buyer.phone }
      const withFee = await create({ items: [{ id: eru.id, quantity: 1 }], total_price: 2700, ...where })
      assertEq(withFee.status, 409, 'charging the 700 fee → refused')
      assertEq(withFee.body.delivery_fee, 0, 'fee 0 today')
      const o = await create({ items: [{ id: eru.id, quantity: 1 }], total_price: 2000, ...where })
      assertEq(o.status, 200, `delivered for free → 200 (${o.raw.slice(0, 160)})`)
      if (o.body.order) track('orders', o.body.order.id)
      const { data } = await sb.from('orders').select('delivery_fee').eq('id', o.body.order?.id ?? '').single()
      assertEq(Number((data as { delivery_fee: number }).delivery_fee), 0, 'stored fee 0')
    })

    await step('ending an offer brings the menu price back', async () => {
      const del = await api(`/api/restaurants/${rest.id}/offers/${ndoleOfferId}`, { cookie: customerCookie(stranger), method: 'DELETE' })
      assertEq(del.status, 403, 'stranger can\'t end it')
      const ok = await api(`/api/restaurants/${rest.id}/offers/${ndoleOfferId}`, { cookie: ownerCookie, method: 'DELETE' })
      assertEq(ok.status, 200, 'owner ends it')
      const r = await create({ items: [{ id: ndole.id, quantity: 1 }], total_price: 3000 })
      assertEq(r.status, 200, 'ndolé back at 3 000')
      if (r.body.order) track('orders', r.body.order.id)
    })
  } catch (e) {
    assert(false, 'suite crashed', (e as Error).stack)
  } finally {
    await teardown()
  }
  finish(SUITE)
}

void main()
