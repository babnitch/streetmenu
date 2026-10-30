// Aperçu figures + anonymous counting rules (pure functions).
//   - periods start at Douala midnight; hours are Douala hours
//   - cancelled / fully refunded orders are counted apart, never in revenue;
//     revenue is net of partial refunds; online = paid by Mobile Money
//   - top dishes, busiest hours
//   - tracking: only known metrics, item ids must be uuids, search words are
//     normalised and phone-number-like searches are dropped; bots ignored

import { periodStart, doualaHour, restaurantFigures, sumStats } from '@/lib/overview'
import { parseTrack, normaliseSearch, isBot } from '@/lib/stats'
import { CITIES } from '@/lib/cities'
import { assert, assertEq, step, finish } from '../testkit/assert'

const SUITE = 'unit-overview-stats'
const U = '11111111-2222-3333-4444-555555555555'

async function main(): Promise<void> {
  await step('periods and Douala hours', () => {
    assertEq(periodStart('today', '2026-10-30'), { day: '2026-10-30', iso: '2026-10-29T23:00:00.000Z' }, 'today starts at Douala midnight')
    assertEq(periodStart('7d', '2026-10-30').day, '2026-10-24', '7 days = today + 6 before')
    assertEq(periodStart('30d', '2026-10-30').day, '2026-10-01', '30 days')
    assertEq(doualaHour('2026-10-30T23:30:00Z'), 0, '23:30 UTC = 00h in Douala')
    assertEq(doualaHour('2026-10-30T11:05:00Z'), 12, '11:05 UTC = 12h')
  })

  await step('restaurant figures', () => {
    const f = restaurantFigures([
      { created_at: '2026-10-30T11:00:00Z', status: 'completed', payment_status: 'paid', total_price: 3000, refunded_amount: 500, fulfilment: 'delivery', items: [{ name: 'Ndolé', quantity: 2 }, { name: 'Jus', quantity: 1 }] },
      { created_at: '2026-10-30T11:40:00Z', status: 'confirmed', payment_status: 'not_required', total_price: 2000, fulfilment: 'pickup', items: [{ name: 'Ndolé', quantity: 1 }] },
      { created_at: '2026-10-30T18:00:00Z', status: 'cancelled', payment_status: 'paid', total_price: 9999, items: [{ name: 'X', quantity: 9 }] },
      { created_at: '2026-10-30T18:10:00Z', status: 'confirmed', payment_status: 'refunded', total_price: 1500, items: [{ name: 'Y', quantity: 1 }] },
    ])
    assertEq([f.orders, f.cancelled], [2, 2], '2 counted, cancelled + fully refunded apart')
    assertEq([f.revenue, f.online, f.onSite, f.average], [4500, 2500, 2000, 2250], 'revenue net of refunds, split online / sur place')
    assertEq([f.delivery, f.pickup], [1, 1], 'delivery vs take-away')
    assertEq(f.topDishes, [{ name: 'Ndolé', quantity: 3 }, { name: 'Jus', quantity: 1 }], 'top dishes, cancelled ones excluded')
    assertEq(f.hours, [{ hour: 12, orders: 2 }], 'busiest hour in Douala time')
    assertEq(sumStats([{ metric: 'view', count: 5 }, { metric: 'click_call', count: 2 }, { metric: 'view', count: 1 }]), { views: 6, clicks: { click_call: 2 } }, 'views and clicks summed')
  })

  await step('tracking rules', () => {
    assertEq(parseTrack({ m: 'visit', c: 'Douala' }, CITIES), { metric: 'visit', type: '', id: '', city: 'Douala' }, 'visit')
    assertEq(parseTrack({ m: 'view', t: 'restaurant', i: U, c: 'Nowhere' }, CITIES), { metric: 'view', type: 'restaurant', id: U, city: '' }, 'unknown city → blank')
    assertEq(parseTrack({ m: 'view', t: 'restaurant', i: 'drop table' }, CITIES), null, 'item id must be a uuid')
    assertEq(parseTrack({ m: 'hack', t: 'event', i: U }, CITIES), null, 'unknown metric ignored')
    assertEq(parseTrack({ m: 'search', q: '  Poulet   DG ' }, CITIES)?.id, 'poulet dg', 'search words normalised')
    assertEq(normaliseSearch('+237 690 12 34 56'), null, 'a phone number is never stored')
    assertEq(normaliseSearch('a'), null, 'too short')
    assert(isBot('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'), 'Googlebot ignored')
    assert(isBot('WhatsApp/2.23.20.0'), 'WhatsApp preview ignored')
    assert(isBot(null), 'no user agent ignored')
    assert(!isBot('Mozilla/5.0 (Linux; Android 13; SM-A145F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0 Mobile Safari/537.36'), 'a phone browser counts')
  })
  finish(SUITE)
}

void main()
