// V3 — the home page's three rows, over HTTP.
//
// /api/offers/today?city=…  "Offres du jour": dish offers (menu price, offer
//                            price) and free delivery, live restaurants only.
// /api/popular?city=…       restaurants carry delivery on/off, fee (0 on a
//                            free-delivery day), prep and ride minutes;
//                            events carry price_from / is_free.
//
// Every phone is +999. Rows are inserted directly (no publish, no fan-out).

import { sb } from '../testkit/env'
import { assert, assertEq, step, finish } from '../testkit/assert'
import { api } from '../testkit/session'
import { makeCustomer, makeRestaurant, makeMenuItem, makeEvent, makeTier, futureDateISO } from '../testkit/fixtures'
import { teardown, track } from '../testkit/ledger'
import { dateInZone } from '../../lib/offers'

const SUITE = 'api-home-v3'
const CITY = 'Yaoundé'

interface CityOffer { kind: string; restaurant: { id: string }; dish?: { id: string; regular_price: number; offer_price: number } }
interface PopRest { id: string; delivery_enabled: boolean; delivery_fee: number; free_delivery: boolean; prep_time_min: number; delivery_extra_min: number }
interface PopEvent { id: string; price_from: number; is_free: boolean; has_tiers: boolean }

async function insertMany(table: string, rows: Record<string, unknown>[]): Promise<void> {
  const { data, error } = await sb.from(table).insert(rows as never).select('id')
  if (error) throw new Error(`insert ${table}: ${error.message}`)
  for (const r of (data ?? []) as Array<{ id: string }>) track(table, r.id)
}

async function main(): Promise<void> {
  try {
    const owner = await makeCustomer({ suiteNo: 69, name: 'Home Owner' })
    const buyer = await makeCustomer({ suiteNo: 69, name: 'Home Buyer' })
    const today = dateInZone('Africa/Douala')
    const deliv = await makeRestaurant({ ownerId: owner.id, label: 'home_deliv', city: CITY, whatsapp: owner.phone,
      extra: { prep_time_min: 20, prep_time_max: 30, delivery_enabled: true, delivery_fee: 800, delivery_extra_min: 10, timezone: 'Africa/Douala' } })
    const pickup = await makeRestaurant({ label: 'home_pickup', city: CITY, extra: { prep_time_min: 15, prep_time_max: 20, timezone: 'Africa/Douala' } })
    const hidden = await makeRestaurant({ label: 'home_hidden', city: CITY, isActive: false, status: 'pending', extra: { timezone: 'Africa/Douala' } })
    const dish = await makeMenuItem(deliv.id, { price: 4000, extra: { photo_url: 'https://example.com/d.jpg' } })
    const hiddenDish = await makeMenuItem(hidden.id, { price: 3000 })

    // Enough recent orders to put both restaurants in the city's top 6.
    const order = (rid: string) => ({ restaurant_id: rid, customer_id: buyer.id, customer_name: buyer.name, customer_phone: buyer.phone,
      items: [{ name: 'x', quantity: 1, price: 1000 }], total_price: 1000, status: 'delivered' })
    await insertMany('orders', [...Array(40)].map(() => order(deliv.id)).concat([...Array(39)].map(() => order(pickup.id))))

    await sb.from('menu_offers').insert([
      { restaurant_id: deliv.id, menu_item_id: dish.id, kind: 'price', offer_price: 3000, starts_on: today, ends_on: today },
      { restaurant_id: deliv.id, kind: 'free_delivery', starts_on: today, ends_on: today },
      { restaurant_id: hidden.id, menu_item_id: hiddenDish.id, kind: 'price', offer_price: 1000, starts_on: today, ends_on: today },
    ] as never)

    await step('"Offres du jour": the dish offer and free delivery, not a hidden restaurant', async () => {
      const r = await api<{ offers?: CityOffer[] }>(`/api/offers/today?city=${encodeURIComponent(CITY)}`)
      assertEq(r.status, 200, 'HTTP 200')
      const mine = (r.body.offers ?? []).filter(o => o.restaurant.id === deliv.id)
      const d = mine.find(o => o.kind === 'price')
      assert(!!d && d.dish?.regular_price === 4000 && d.dish?.offer_price === 3000, 'dish at 3 000 instead of 4 000')
      assert(mine.some(o => o.kind === 'free_delivery'), 'free delivery listed')
      assert(!(r.body.offers ?? []).some(o => o.restaurant.id === hidden.id), 'inactive restaurant left out')
      assertEq((await api(`/api/offers/today?city=Nowhere`)).status, 400, 'unknown city → 400')
    })

    await step('popular restaurants carry what the card shows', async () => {
      const r = await api<{ restaurants?: PopRest[]; events?: PopEvent[] }>(`/api/popular?city=${encodeURIComponent(CITY)}`)
      assertEq(r.status, 200, 'HTTP 200')
      const d = r.body.restaurants?.find(x => x.id === deliv.id)
      const p = r.body.restaurants?.find(x => x.id === pickup.id)
      assert(!!d && !!p, 'both test restaurants are in the top list')
      assert(d!.delivery_enabled === true && d!.free_delivery === true && d!.delivery_fee === 0, 'delivery, free today, fee 0')
      assertEq(d!.delivery_extra_min, 10, 'ride minutes for "30-40 min"')
      assert(p!.delivery_enabled === false && p!.prep_time_min === 15, 'take-away with its prep time')
    })

    await step('popular events: "Gratuit", one price, or "from" the lowest tier', async () => {
      const org = await makeCustomer({ suiteNo: 69, name: 'Home Organiser' })
      const date = futureDateISO(10)
      const free = await makeEvent({ organizerId: org.id, label: 'home_free', city: CITY, isActive: true, date, ticketPrice: 0 })
      const paid = await makeEvent({ organizerId: org.id, label: 'home_paid', city: CITY, isActive: true, date, ticketPrice: 2500 })
      const tiered = await makeEvent({ organizerId: org.id, label: 'home_tiers', city: CITY, isActive: true, date, ticketPrice: 0 })
      await makeTier(tiered.id, { name: 'Standard', price: 3000 })
      await makeTier(tiered.id, { name: 'VIP', price: 8000 })
      const seat = (eventId: string) => ({ event_id: eventId, customer_id: buyer.id, customer_name: buyer.name, customer_phone: buyer.phone, quantity: 50, reservation_status: 'confirmed' })
      await insertMany('event_reservations', [seat(free.id), seat(paid.id), seat(tiered.id)])

      const r = await api<{ events?: PopEvent[] }>(`/api/popular?city=${encodeURIComponent(CITY)}`)
      const ev = (id: string) => r.body.events?.find(e => e.id === id)
      assert(ev(free.id)?.is_free === true, 'free event → Gratuit')
      assert(ev(paid.id)?.price_from === 2500 && ev(paid.id)?.has_tiers === false, 'one price 2 500')
      assert(ev(tiered.id)?.price_from === 3000 && ev(tiered.id)?.has_tiers === true, 'tiers → from 3 000')
    })
  } catch (e) {
    assert(false, 'suite crashed', (e as Error).stack)
  } finally {
    await teardown()
  }
  finish(SUITE)
}

void main()
