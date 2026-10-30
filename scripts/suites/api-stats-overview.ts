// Anonymous counts + Aperçu + Admin → Statistiques, against the live API.
//   - /api/track bumps a daily count (views, clicks, searches); bots and
//     unknown items are ignored; nothing identifying is stored
//   - restaurant Aperçu: owner / manager only; figures from its orders
//   - organiser overview: own upcoming events only
//   - Admin → Statistiques: admin + super admin, not moderators / customers
// Test rows only (a test restaurant / event; unique search words); cleaned.

import { sb, testName } from '../testkit/env'
import { assert, assertEq, step, finish } from '../testkit/assert'
import { api, adminCookie, customerCookie, staffCookie } from '../testkit/session'
import { makeCustomer, makeRestaurant, makeOrder, makeEvent, addTeamMember } from '../testkit/fixtures'
import { teardown, track } from '../testkit/ledger'

const SUITE = 'api-stats-overview'
const UA = { 'User-Agent': 'Mozilla/5.0 (Linux; Android 13; SM-A145F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0 Mobile Safari/537.36' }

async function count(type: string, id: string, metric: string): Promise<number> {
  const { data } = await sb.from('stats_daily').select('count').eq('item_type', type).eq('item_id', id).eq('metric', metric)
  return (data ?? []).reduce((a, r) => a + (r as { count: number }).count, 0)
}
const beacon = (body: Record<string, string>, headers: Record<string, string> = UA) => api('/api/track', { body, headers })

async function main(): Promise<void> {
  const words = testName('srch').toLowerCase().replace(/_/g, ' ').trim().slice(0, 40)
  let restId = '', evId = ''
  try {
    const owner = await makeCustomer({ suiteNo: 99, name: 'Stats Owner' })
    const staff = await makeCustomer({ suiteNo: 99, name: 'Stats Staff' })
    const buyer = await makeCustomer({ suiteNo: 99, name: 'Stats Buyer' })
    const rest = await makeRestaurant({ ownerId: owner.id, label: 'stats_r' })
    restId = rest.id
    await addTeamMember(rest.id, staff.id, 'staff')
    const o1 = await makeOrder(rest.id, buyer, { total: 3000, status: 'confirmed', extra: { payment_status: 'paid', fulfilment: 'pickup', items: [{ name: 'Ndolé', quantity: 2, price: 1500 }] } })
    const o2 = await makeOrder(rest.id, buyer, { total: 1000, status: 'cancelled' })
    track('orders', o1.id); track('orders', o2.id)
    const ev = await makeEvent({ organizerId: owner.id, label: 'stats_ev', maxTickets: 20 })
    evId = ev.id

    await step('/api/track counts views, clicks, searches; ignores bots and junk', async () => {
      assertEq((await beacon({ m: 'view', t: 'restaurant', i: rest.id })).status, 204, 'beacon → 204')
      await beacon({ m: 'view', t: 'restaurant', i: rest.id })
      await beacon({ m: 'click_whatsapp', t: 'restaurant', i: rest.id })
      await beacon({ m: 'view', t: 'event', i: ev.id })
      await beacon({ m: 'view', t: 'restaurant', i: rest.id }, { 'User-Agent': 'Googlebot/2.1 (+http://www.google.com/bot.html)' })
      await beacon({ m: 'view', t: 'restaurant', i: 'not-a-uuid' })
      await beacon({ m: 'search', q: words })
      assertEq(await count('restaurant', rest.id, 'view'), 2, '2 views (the bot is ignored)')
      assertEq(await count('restaurant', rest.id, 'click_whatsapp'), 1, '1 WhatsApp click')
      assertEq(await count('search', words, 'search'), 1, 'search words counted')
      const { data: cols } = await sb.from('stats_daily').select('*').eq('item_id', rest.id).limit(1)
      assertEq(Object.keys((cols ?? [])[0] ?? {}).sort(), ['city', 'count', 'day', 'item_id', 'item_type', 'metric'], 'nothing else is stored')
    })

    await step('restaurant Aperçu: owner yes, staff / others no', async () => {
      const r = await api<{ orders: number; revenue: number; online: number; cancelled: number; topDishes: Array<{ name: string }>; views: number; clicks: Record<string, number> }>(`/api/restaurants/${rest.id}/overview?period=today`, { cookie: customerCookie(owner) })
      assertEq(r.status, 200, 'owner → 200')
      assertEq([r.body.orders, r.body.revenue, r.body.online, r.body.cancelled], [1, 3000, 3000, 1], 'figures')
      assertEq(r.body.topDishes[0]?.name, 'Ndolé', 'top dish')
      assertEq([r.body.views, r.body.clicks.click_whatsapp], [2, 1], 'views and clicks')
      assertEq((await api(`/api/restaurants/${rest.id}/overview`, { cookie: customerCookie(staff) })).status, 403, 'staff → 403')
      assertEq((await api(`/api/restaurants/${rest.id}/overview`, { cookie: customerCookie(buyer) })).status, 403, 'another customer → 403')
      assertEq((await api(`/api/restaurants/${rest.id}/overview?period=1y`, { cookie: customerCookie(owner) })).status, 400, 'bad period → 400')
    })

    await step('organiser overview: own events only', async () => {
      const r = await api<{ events: Array<{ id: string; views: number }>; totals: { events: number } }>('/api/pro/events-overview', { cookie: customerCookie(owner) })
      assertEq(r.status, 200, 'organiser → 200')
      const mine = r.body.events.find(e => e.id === ev.id)
      assert(!!mine, 'their event is listed')
      assertEq(mine?.views, 1, 'its page views')
      const other = await api<{ events: Array<{ id: string }> }>('/api/pro/events-overview', { cookie: customerCookie(buyer) })
      assert(!other.body.events.some(e => e.id === ev.id), 'not in someone else\'s overview')
    })

    await step('Admin → Statistiques: admin + super admin only', async () => {
      const s = await api<{ searches: Array<{ words: string }>; tops: { restaurant: { byViews: Array<{ id: string; conversions: number }> } } }>('/api/admin/stats?days=7', { cookie: await adminCookie() })
      assertEq(s.status, 200, 'super admin → 200')
      assert(s.body.searches.some(x => x.words === words), 'the search shows in top searches')
      const mod = staffCookie({ id: owner.id, email: 'm@test.invalid', name: 'Mod', role: 'moderator' })
      assertEq((await api('/api/admin/stats', { cookie: mod })).status, 401, 'moderator → 401')
      assertEq((await api('/api/admin/stats', { cookie: customerCookie(owner) })).status, 401, 'customer → 401')
    })
  } catch (e) {
    assert(false, 'suite crashed', (e as Error).stack)
  } finally {
    if (restId) await sb.from('stats_daily').delete().in('item_id', [restId, evId, words].filter(Boolean))
    await teardown()
  }
  finish(SUITE)
}

void main()
