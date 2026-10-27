// Events listing rules (lib/eventStatus.ts): the status line thresholds,
// "Dès X FCFA" and the "À la une" pick. Pure — no server, no DB.

import { eventStatus, statusText, fromPrice, pickFeatured, type ListingDay } from '@/lib/eventStatus'
import { assertEq, step, finish } from '../testkit/assert'

const SUITE = 'unit-event-status'
const day = (date: string, capacity: number, sold: number, minPrice: number | null = 1000): ListingDay => {
  const remaining = capacity > 0 ? Math.max(0, capacity - sold) : null
  return { date, capacity, sold, remaining, soldOut: remaining === 0, minPrice }
}
const label = (iso: string) => iso.slice(8) + '/' + iso.slice(5, 7)

async function main(): Promise<void> {
  await step('status line: first match wins', () => {
    assertEq(eventStatus([day('2026-11-01', 5, 5), day('2026-11-02', 5, 5)], null, 0), { kind: 'sold_out' }, 'every day full → Épuisé')
    assertEq(eventStatus([day('2026-11-01', 5, 5), day('2026-11-02', 5, 1)], '2026-11-01', 0), { kind: 'sold_out_day', day: '2026-11-01' }, 'shown day full, another open')
    assertEq(eventStatus([day('2026-11-01', 100, 91)], null, 0), { kind: 'few', left: 9 }, '9 left (≤ 10)')
    assertEq(eventStatus([day('2026-11-01', 200, 165)], null, 0), { kind: 'few', left: 35 }, '35 of 200 left (≤ 20 %)')
    assertEq(eventStatus([day('2026-11-01', 100, 60)], null, 0), { kind: 'busy' }, '60 % taken → busy')
    assertEq(eventStatus([day('2026-11-01', 100, 59)], null, 0), null, '59 % → nothing')
    assertEq(eventStatus([day('2026-11-01', 0, 30)], null, 20), { kind: 'busy' }, 'unlimited, 20 seats in 7 days → busy')
    assertEq(eventStatus([day('2026-11-01', 0, 30)], null, 19), null, 'unlimited, 19 → nothing')
    assertEq(eventStatus([], null, 50), null, 'no upcoming day → nothing')
  })

  await step('status text, FR and EN', () => {
    assertEq(statusText({ kind: 'sold_out_day', day: '2026-11-01' }, '2026-11-01', 'fr', label), "Épuisé aujourd'hui · autres dates dispo", 'today FR')
    assertEq(statusText({ kind: 'sold_out_day', day: '2026-11-02' }, '2026-11-01', 'en', label), 'Sold out on 02/11 · other dates available', 'other day EN')
    assertEq(statusText({ kind: 'few', left: 1 }, '', 'fr', label), 'Plus que 1 place', 'singular')
    assertEq(statusText({ kind: 'sold_out' }, '', 'en', label), 'Sold out', 'Sold out')
    assertEq(statusText({ kind: 'busy' }, '', 'fr', label), 'Beaucoup de réservations', 'busy FR')
  })

  await step('"Dès X FCFA": cheapest price still on sale', () => {
    assertEq(fromPrice([day('2026-11-01', 5, 5, 500), day('2026-11-02', 5, 0, 1500)]), 1500, 'a full day does not count')
    assertEq(fromPrice([day('2026-11-01', 5, 0, 0)]), 0, 'free → 0 (Gratuit)')
    assertEq(fromPrice([day('2026-11-01', 5, 5, 500)]), null, 'nothing on sale → null')
  })

  await step('"À la une": admin pick → paid promotion → most bookings → soonest', () => {
    const ev = [
      { id: 'a', is_featured: false, firstDay: '2026-11-05', bookings30d: 3 },
      { id: 'b', is_featured: false, firstDay: '2026-11-02', bookings30d: 9 },
      { id: 'c', is_featured: true,  firstDay: '2026-11-09', bookings30d: 0 },
    ]
    assertEq(pickFeatured(ev, ['a']), 'c', 'admin pick first')
    assertEq(pickFeatured(ev.map(e => ({ ...e, is_featured: false })), ['a']), 'a', 'then the paid promotion')
    assertEq(pickFeatured(ev.map(e => ({ ...e, is_featured: false })), []), 'b', 'then most bookings')
    assertEq(pickFeatured(ev.map(e => ({ ...e, is_featured: false, bookings30d: 0 })), []), 'b', 'nobody booked → soonest')
    assertEq(pickFeatured([], []), null, 'no event → none')
  })

  finish(SUITE)
}

void main()
