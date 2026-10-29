// U3 — "Ce week-end" = Friday 17:00 → Sunday 23:59 (Africa/Douala). A
// Saturday or Sunday counts; a Friday counts only in the evening (no time,
// from 17:00, ending after 17:00, or carrying on to Saturday). "Ce mois" =
// today → end of month. (2026-10-29 is a Thursday.)

import { weekendWindow, weekendDay, onFridayEvening, restOfMonth, listingDays, todayInDouala } from '@/lib/weekend'
import { assert, assertEq, step, finish } from '../testkit/assert'

const SUITE = 'unit-weekend-u3'
const W = { fri: '2026-10-30', sat: '2026-10-31', sun: '2026-11-01' }

async function main(): Promise<void> {
  await step('the weekend window from any day', () => {
    assertEq(weekendWindow('2026-10-26'), W, 'Monday → the coming weekend')
    assertEq(weekendWindow('2026-10-29'), W, 'Thursday')
    assertEq(weekendWindow('2026-10-30'), W, 'Friday → this one')
    assertEq(weekendWindow('2026-11-01'), W, 'Sunday → still this one')
    assertEq(weekendWindow('2026-11-02').fri, '2026-11-06', 'next Monday → the next one')
  })

  await step('Friday counts in the evening only', () => {
    const fri = (time: string | null, end_time: string | null = null) => ({ date: W.fri, end_date: null, time, end_time })
    assert(onFridayEvening(fri('20:00'), W.fri), '20:00 → yes')
    assert(onFridayEvening(fri('17:00'), W.fri), '17:00 → yes')
    assert(!onFridayEvening(fri('10:00', '14:00'), W.fri), '10:00–14:00 → no')
    assert(onFridayEvening(fri('15:00', '19:00'), W.fri), '15:00–19:00 → yes (runs into the evening)')
    assert(onFridayEvening(fri(null), W.fri), 'no time → yes')
    assert(onFridayEvening({ date: W.fri, end_date: W.sat, time: '09:00', end_time: null }, W.fri), 'carries on to Saturday → yes')
  })

  await step('which day of an event is "this weekend"', () => {
    const e = (date: string, time: string | null, end_date: string | null = null) => ({ date, end_date, time, end_time: null })
    assertEq(weekendDay(e(W.sat, '14:00'), [W.sat], W), W.sat, 'Saturday afternoon')
    assertEq(weekendDay(e(W.sun, '23:00'), [W.sun], W), W.sun, 'Sunday night')
    assertEq(weekendDay(e(W.fri, '09:00'), [W.fri], W), null, 'Friday morning → no')
    assertEq(weekendDay(e(W.fri, '21:00'), [W.fri], W), W.fri, 'Friday night')
    assertEq(weekendDay(e('2026-10-28', '10:00', '2026-11-03'), ['2026-10-29', W.fri, W.sat, W.sun, '2026-11-02'], W), W.fri, 'long event → from Friday')
    assertEq(weekendDay(e('2026-11-03', '20:00'), ['2026-11-03'], W), null, 'next Tuesday → no')
  })

  await step('"Ce mois" and the listing days', () => {
    const m = restOfMonth('2026-10-29')
    assertEq([m[0], m[m.length - 1], m.length], ['2026-10-29', '2026-10-31', 3], 'today → 31 Oct')
    assertEq(restOfMonth('2026-02-27').length, 2, 'February')
    assertEq(listingDays({ date: '2026-10-25', end_date: '2026-11-02', days: [] }, '2026-10-31'), ['2026-10-31', '2026-11-01', '2026-11-02'], 'past days dropped')
    assertEq(listingDays({ date: W.sat, days: [{ date: W.sat }] }, '2026-10-29'), [W.sat], 'the listing\'s own days first')
    assert(/^\d{4}-\d{2}-\d{2}$/.test(todayInDouala()), 'today in Douala')
  })

  finish(SUITE)
}

void main()
