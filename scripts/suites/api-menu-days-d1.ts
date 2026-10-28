// D1 — Menu par jour on the server and in the bot.
//
// Type de menu (owner/manager): À la carte (default) or Menu par jour. Dish
// days (0 = Sunday … 6 = Saturday) through the menu API. In Menu par jour an
// order with a dish not served today (the restaurant's day) is refused —
// 409 not_today, the dish marked unavailable for the cart; À la carte
// ignores the days. The bot lists only today's dishes.
//
// Every phone is +999; the bot runs in a per-run city.

import { sb, testName } from '../testkit/env'
import { assert, assertEq, step, finish } from '../testkit/assert'
import { api, customerCookie } from '../testkit/session'
import { makeCustomer, makeRestaurant, makeMenuItem } from '../testkit/fixtures'
import { teardown, track } from '../testkit/ledger'
import { weekdayInZone, daysLabel, availableOnText, validateDays, ALL_DAYS } from '../../lib/menuDays'

const SUITE = 'api-menu-days-d1'
const CITY = testName('city')

interface Body { ok?: boolean; reason?: string; error?: string; current?: Array<{ id: string; available: boolean }>; order?: { id: string } }

const send = (phone: string, body: string) =>
  api('/api/whatsapp/incoming', { form: { From: `whatsapp:${phone}`, Body: body } })

async function main(): Promise<void> {
  try {
    await step('days: the restaurant\'s weekday, labels, validation', async () => {
      // 2026-10-31 is a Saturday; 23:30 UTC is already Sunday in Douala (UTC+1).
      assertEq(weekdayInZone('Africa/Douala', new Date('2026-10-31T12:00:00Z')), 6, 'Saturday noon → 6')
      assertEq(weekdayInZone('Africa/Douala', new Date('2026-10-31T23:30:00Z')), 0, '23:30 UTC Saturday → Sunday in Douala')
      assertEq(daysLabel([6], 'fr'), 'le samedi', 'FR one day')
      assertEq(availableOnText([6], 'en'), 'Available on Saturday', 'EN one day')
      assertEq(daysLabel([6, 0], 'fr'), 'le samedi et le dimanche', 'FR two days, week order')
      assertEq(daysLabel([1, 3, 5], 'fr'), 'lun., mer. et ven.', 'FR three days')
      assert(!validateDays([]).ok && !validateDays([7]).ok, 'no day / day 7 refused')
      assertEq(validateDays([0, 6, 6, 1]), { ok: true, days: [0, 1, 6] }, 'deduped and sorted')
    })

    const owner = await makeCustomer({ suiteNo: 78, name: 'Days Owner' })
    const buyer = await makeCustomer({ suiteNo: 78, name: 'Days Buyer', extra: { city: CITY } })
    const oc = customerCookie(owner)
    const rest = await makeRestaurant({ ownerId: owner.id, label: 'days_r', whatsapp: owner.phone, city: CITY, extra: { timezone: 'Africa/Douala' } })
    const today = weekdayInZone('Africa/Douala')
    const otherDays = ALL_DAYS.filter(d => d !== today)

    await step('Type de menu: owner sets it, bad value refused', async () => {
      assertEq((await api<Body>(`/api/restaurants/${rest.id}`, { method: 'PATCH', cookie: oc, body: { menu_type: 'weekly' } })).status, 400, 'bad type → 400')
      const r = await api<Body>(`/api/restaurants/${rest.id}`, { method: 'PATCH', cookie: oc, body: { menu_type: 'daily' } })
      assertEq(r.status, 200, `daily → 200 (${r.raw.slice(0, 80)})`)
      const { data } = await sb.from('restaurants').select('menu_type').eq('id', rest.id).single()
      assertEq((data as { menu_type: string }).menu_type, 'daily', 'stored')
    })

    let notTodayId = ''
    let everyDayId = ''
    await step('dish days through the menu API', async () => {
      const bad = await api<Body>(`/api/restaurants/${rest.id}/menu`, { cookie: oc, body: { name: testName('days_bad'), price: 1000, available_days: [] } })
      assertEq(bad.status, 400, 'no day → 400')
      const c = await api<{ item?: { id: string; available_days: number[] }; id?: string }>(`/api/restaurants/${rest.id}/menu`, { cookie: oc, body: { name: testName('days_other'), price: 2000, available_days: otherDays } })
      assert(c.status === 200 || c.status === 201, `created (${c.status} ${c.raw.slice(0, 80)})`)
      const { data: row } = await sb.from('menu_items').select('id, available_days').eq('restaurant_id', rest.id).eq('price', 2000).single()
      notTodayId = (row as { id: string }).id
      track('menu_items', notTodayId)
      assertEq((row as { available_days: number[] }).available_days, otherDays, 'stored without today')
      everyDayId = (await makeMenuItem(rest.id, { price: 1500 })).id
      const p = await api(`/api/restaurants/${rest.id}/menu/${everyDayId}`, { method: 'PATCH', cookie: oc, body: { available_days: [...ALL_DAYS] } })
      assertEq(p.status, 200, 'PATCH days → 200')
    })

    const create = (items: Array<{ id: string; quantity: number }>, total: number) =>
      api<Body>('/api/orders/create', { cookie: customerCookie(buyer), body: { restaurant_id: rest.id, order_type: 'reservation', items, total_price: total } })

    await step('Menu par jour: a dish not served today is refused, today\'s dish goes through', async () => {
      const r = await create([{ id: notTodayId, quantity: 1 }, { id: everyDayId, quantity: 1 }], 3500)
      assertEq(r.status, 409, 'HTTP 409')
      assertEq(r.body.reason, 'not_today', 'reason not_today')
      assert(/Pas disponible aujourd'hui/.test(r.body.error ?? '') && /Not available today/.test(r.body.error ?? ''), 'FR/EN message')
      assertEq(r.body.current?.find(c => c.id === notTodayId)?.available, false, 'the cart is told to drop it')
      const ok = await create([{ id: everyDayId, quantity: 1 }], 1500)
      assertEq(ok.status, 200, `today's dish → 200 (${ok.raw.slice(0, 80)})`)
      if (ok.body.order) track('orders', ok.body.order.id)
    })

    await step('bot: only today\'s dishes', async () => {
      await send(buyer.phone, 'fr')
      await send(buyer.phone, 'commander')
      const { data: s1 } = await sb.from('signup_sessions').select('data').eq('phone', buyer.phone).single()
      const cands = ((s1 as { data: { candidates: Array<{ id: string }> } }).data.candidates)
      await send(buyer.phone, String(cands.findIndex(c => c.id === rest.id) + 1))
      const { data: s2 } = await sb.from('signup_sessions').select('data').eq('phone', buyer.phone).single()
      const menu = ((s2 as { data: { menu?: Array<{ menu_item_id: string }> } }).data.menu ?? []).map(m => m.menu_item_id)
      assert(menu.includes(everyDayId), 'today\'s dish listed')
      assert(!menu.includes(notTodayId), 'the other-days dish is not')
      await send(buyer.phone, 'annuler')
    })

    await step('À la carte ignores the days', async () => {
      await api(`/api/restaurants/${rest.id}`, { method: 'PATCH', cookie: oc, body: { menu_type: 'a_la_carte' } })
      const r = await create([{ id: notTodayId, quantity: 1 }], 2000)
      assertEq(r.status, 200, `same dish à la carte → 200 (${r.raw.slice(0, 80)})`)
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
