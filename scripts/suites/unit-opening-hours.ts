// TEST-PLAN.md §1a #2 — opening hours.
//
// Pure: no server, no DB, no cleanup. Every case pins an explicit `at` Date
// so the result never depends on when the suite runs.
//
// Reference instant: 2026-01-07T12:00:00Z is a Wednesday (day_of_week 3).
// Africa/Douala is UTC+1 with no DST, so that instant is 13:00 local — the
// arithmetic below is stable year-round.

import {
  isRestaurantOpen,
  formatHoursForDisplay,
  nextTransitionLine,
  timezoneForCity,
  type RestaurantHourRow,
  type OpeningLookup,
} from '@/lib/openingHours'
import { assert, assertEq, step, finish } from '../testkit/assert'

const SUITE = 'unit-opening-hours'
const TZ = 'Africa/Douala'

const WED = 3
const THU = 4

function hour(day: number, open: string, close: string, isClosed = false): RestaurantHourRow {
  return { day_of_week: day, open_time: open, close_time: close, is_closed: isClosed }
}

function lookup(hours: RestaurantHourRow[], override: OpeningLookup['manual_override'] = null, tz: string | null = TZ): OpeningLookup {
  return { manual_override: override, timezone: tz, hours }
}

const fullWeek = [0, 1, 2, 3, 4, 5, 6].map(d => hour(d, '08:00', '18:00'))

// Wednesday 13:00 Douala.
const midWindow   = new Date('2026-01-07T12:00:00Z')
// Wednesday 06:00 Douala — before opening.
const beforeOpen  = new Date('2026-01-07T05:00:00Z')
// Wednesday 20:00 Douala — after closing.
const afterClose  = new Date('2026-01-07T19:00:00Z')
// Wednesday 23:00 Douala — inside an overnight window that opened at 22:00.
const lateWed     = new Date('2026-01-07T22:00:00Z')
// Thursday 01:00 Douala — still inside Wednesday's 22:00→02:00 window.
const earlyThu    = new Date('2026-01-08T00:00:00Z')
// Thursday 03:00 Douala — after that window has closed.
const afterOvernight = new Date('2026-01-08T02:00:00Z')

async function main(): Promise<void> {
  await step('isRestaurantOpen — normal same-day window', () => {
    const s = isRestaurantOpen(lookup(fullWeek), midWindow)
    assert(s.open, 'open mid-window (13:00 inside 08:00-18:00)')
    assertEq(s.source, 'schedule', 'source is schedule when no override')
    assertEq(s.current_day, WED, 'current_day resolves to Wednesday')
    assertEq(s.current_time, '13:00', 'current_time is 13:00 in Africa/Douala')

    assert(!isRestaurantOpen(lookup(fullWeek), beforeOpen).open, 'closed before opening (06:00)')
    assert(!isRestaurantOpen(lookup(fullWeek), afterClose).open, 'closed after closing (20:00)')
  })

  await step('isRestaurantOpen — boundaries are half-open [open, close)', () => {
    // 08:00 Douala exactly.
    assert(isRestaurantOpen(lookup(fullWeek), new Date('2026-01-07T07:00:00Z')).open,
      'open exactly at open_time')
    // 18:00 Douala exactly — close_time is exclusive.
    assert(!isRestaurantOpen(lookup(fullWeek), new Date('2026-01-07T17:00:00Z')).open,
      'closed exactly at close_time')
  })

  await step('isRestaurantOpen — past-midnight close (22:00 → 02:00)', () => {
    const overnight = lookup([hour(WED, '22:00', '02:00')])
    assert(isRestaurantOpen(overnight, lateWed).open, 'open at 23:00 on the opening day')
    const thu = isRestaurantOpen(overnight, earlyThu)
    assert(thu.open, 'open at 01:00 next day via yesterday\'s overnight row')
    assertEq(thu.current_day, THU, 'current_day has rolled over to Thursday')
    assert(!isRestaurantOpen(overnight, afterOvernight).open, 'closed at 03:00, after the window ends')
    assert(!isRestaurantOpen(overnight, midWindow).open, 'closed at 13:00 — outside the overnight window')
  })

  await step('isRestaurantOpen — is_closed, missing rows, degenerate rows', () => {
    assert(!isRestaurantOpen(lookup([hour(WED, '08:00', '18:00', true)]), midWindow).open,
      'is_closed=true day reads closed even inside the window')

    const none = isRestaurantOpen(lookup([]), midWindow)
    assert(!none.open, 'no rows at all falls back to closed')
    assertEq(none.source, 'schedule', 'no-rows fallback still reports source=schedule')

    assert(!isRestaurantOpen(lookup([hour(THU, '08:00', '18:00')]), midWindow).open,
      'a row for another day does not open today')

    assert(!isRestaurantOpen(lookup([hour(WED, '12:00', '12:00')]), midWindow).open,
      'degenerate open==close is closed, not 24h')
  })

  await step('isRestaurantOpen — TIME serialisation with seconds', () => {
    assert(isRestaurantOpen(lookup([hour(WED, '08:00:00', '18:00:00')]), midWindow).open,
      "'HH:MM:SS' rows are trimmed and compare correctly")
  })

  await step('isRestaurantOpen — manual override wins over the schedule', () => {
    const openOverride = isRestaurantOpen(lookup([hour(WED, '08:00', '18:00', true)], 'open'), midWindow)
    assert(openOverride.open, "override 'open' beats an is_closed schedule")
    assertEq(openOverride.source, 'override', 'source is override')
    assertEq(openOverride.next_transition, undefined, 'an override reports no next transition')

    const closedOverride = isRestaurantOpen(lookup(fullWeek, 'closed'), midWindow)
    assert(!closedOverride.open, "override 'closed' beats an open schedule")
    assertEq(closedOverride.source, 'override', 'source is override')
  })

  await step('isRestaurantOpen — next_transition', () => {
    const openNow = isRestaurantOpen(lookup(fullWeek), midWindow)
    assertEq(openNow.next_transition?.kind, 'closes', 'while open, the next transition closes')
    assertEq(openNow.next_transition?.at, '18:00', 'and it is at 18:00')

    const closedNow = isRestaurantOpen(lookup(fullWeek), beforeOpen)
    assertEq(closedNow.next_transition?.kind, 'opens', 'while closed, the next transition opens')
    assertEq(closedNow.next_transition?.at, '08:00', 'and it is at 08:00')
  })

  await step('timezone drives the comparison, not the host clock', () => {
    // Same instant, two zones: Douala is UTC+1, Abidjan UTC+0.
    assertEq(isRestaurantOpen(lookup(fullWeek, null, 'Africa/Douala'), midWindow).current_time, '13:00',
      'Douala reads 13:00')
    assertEq(isRestaurantOpen(lookup(fullWeek, null, 'Africa/Abidjan'), midWindow).current_time, '12:00',
      'Abidjan reads 12:00 for the same instant')
    assertEq(isRestaurantOpen(lookup(fullWeek, null, null), midWindow).current_time, '13:00',
      'a null timezone falls back to Africa/Douala')
  })

  await step('timezoneForCity', () => {
    assertEq(timezoneForCity('Abidjan'), 'Africa/Abidjan', 'Abidjan')
    assertEq(timezoneForCity('Dakar'), 'Africa/Dakar', 'Dakar')
    assertEq(timezoneForCity('Lomé'), 'Africa/Lome', 'Lomé (accented)')
    assertEq(timezoneForCity('lome'), 'Africa/Lome', 'lome (unaccented, lowercase)')
    assertEq(timezoneForCity('  DAKAR  '), 'Africa/Dakar', 'case and surrounding space are ignored')
    assertEq(timezoneForCity('Yaoundé'), 'Africa/Douala', 'Yaoundé maps to the Douala zone')
    assertEq(timezoneForCity('Nowhere'), 'Africa/Douala', 'unknown city falls back to Douala')
    assertEq(timezoneForCity(null), 'Africa/Douala', 'null falls back to Douala')
    assertEq(timezoneForCity(undefined), 'Africa/Douala', 'undefined falls back to Douala')
  })

  await step('formatHoursForDisplay groups consecutive identical days', () => {
    assertEq(formatHoursForDisplay(fullWeek, 'fr'), ['Lun–Dim: 08:00 - 18:00'],
      'a uniform week collapses to one Mon–Sun line')

    const mixed = [
      hour(1, '08:00', '18:00'), hour(2, '08:00', '18:00'), hour(3, '08:00', '18:00'),
      hour(4, '08:00', '18:00'), hour(5, '08:00', '18:00'),
      hour(6, '10:00', '23:00'),
      hour(0, '00:00', '00:00', true),
    ]
    assertEq(formatHoursForDisplay(mixed, 'fr'),
      ['Lun–Ven: 08:00 - 18:00', 'Sam: 10:00 - 23:00', 'Dim: Fermé'],
      'weekday run, then Saturday, then a closed Sunday (FR)')
    assertEq(formatHoursForDisplay(mixed, 'en'),
      ['Mon–Fri: 08:00 - 18:00', 'Sat: 10:00 - 23:00', 'Sun: Closed'],
      'same grouping in EN')

    assertEq(formatHoursForDisplay([], 'fr'), ['Lun–Dim: Fermé'],
      'no rows renders as a fully closed week')
  })

  await step('nextTransitionLine', () => {
    const open = isRestaurantOpen(lookup(fullWeek), midWindow)
    assertEq(nextTransitionLine(open, 'fr'), 'Ouvert · ferme à 18:00', 'open, FR')
    assertEq(nextTransitionLine(open, 'en'), 'Open · closes at 18:00', 'open, EN')

    const closed = isRestaurantOpen(lookup(fullWeek), beforeOpen)
    assertEq(nextTransitionLine(closed, 'fr'), 'Fermé · ouvre à 08:00', 'closed, FR')
    assertEq(nextTransitionLine(closed, 'en'), 'Closed · opens at 08:00', 'closed, EN')

    // An override has no next_transition — the line degrades to a bare word.
    const overridden = isRestaurantOpen(lookup(fullWeek, 'closed'), midWindow)
    assertEq(nextTransitionLine(overridden, 'fr'), 'Fermé', 'no transition, FR')
    assertEq(nextTransitionLine(overridden, 'en'), 'Closed', 'no transition, EN')
    assertEq(nextTransitionLine(isRestaurantOpen(lookup(fullWeek, 'open'), midWindow), 'fr'), 'Ouvert',
      'override open with no transition, FR')
  })

  finish(SUITE)
}

void main()
