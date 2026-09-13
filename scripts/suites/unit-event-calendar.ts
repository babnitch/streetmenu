// Events-tab calendar maths (lib/eventCalendar.ts): the day strip, the weekend
// pill, the month picker grid and the per-day event dots.
//
// Pure: no server, no DB, no cleanup. Every case pins `today` / `now`, so the
// result never depends on when the suite runs.
//
// Reference day: 2026-09-13, a Sunday. The week after it runs Monday 14 →
// Sunday 20 September 2026.

import { type EventWhen } from '@/lib/eventDate'
import {
  HORIZON_DAYS,
  STRIP_DAYS,
  addDays,
  addMonths,
  daysBetween,
  eventDaySet,
  eventsOnDays,
  isPickableDay,
  lastPickerMonth,
  localDayISO,
  monthGrid,
  nextEventDay,
  pastEvents,
  selectionDays,
  stripDays,
  weekdayIndex,
  weekendDays,
} from '@/lib/eventCalendar'
import { assert, assertEq, step, finish } from '../testkit/assert'

const SUITE = 'unit-event-calendar'
const TODAY = '2026-09-13'                       // Sunday
const NOW = new Date('2026-09-13T12:00:00Z')

type TestEvent = EventWhen & { id: string }

function ev(id: string, date: string, endDate: string | null = null, time: string | null = null): TestEvent {
  return { id, date, end_date: endDate, time, end_time: null }
}

const ids = (events: TestEvent[]) => events.map(e => e.id)

// Checks the shape every month grid must have, then returns its rows.
function checkGrid(month: string, expectedRows: number, label: string): Array<Array<string | null>> {
  const rows = monthGrid(month)
  assertEq(rows.length, expectedRows, `${label}: ${expectedRows} rows`)
  assert(rows.every(row => row.length === 7), `${label}: every row has 7 cells`)
  const [year, monthNumber] = month.split('-').map(Number)
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10)
  assertEq(rows.flat().filter(Boolean), daysBetween(`${month}-01`, lastDay),
    `${label}: each day of the month appears once, in order`)
  assert(rows[0].some(Boolean) && rows[rows.length - 1].some(Boolean), `${label}: no empty first or last row`)
  return rows
}

async function main(): Promise<void> {
  await step('localDayISO reads the phone\'s local calendar day', () => {
    assertEq(localDayISO(new Date(2026, 8, 13, 0, 30)), '2026-09-13', 'just after local midnight')
    assertEq(localDayISO(new Date(2026, 8, 13, 23, 30)), '2026-09-13', 'just before local midnight')
    assertEq(localDayISO(new Date(2026, 0, 5, 12)), '2026-01-05', 'month and day are zero-padded')
  })

  await step('addDays and weekdayIndex', () => {
    assertEq(addDays('2026-01-31', 1), '2026-02-01', 'across a month end')
    assertEq(addDays('2026-12-31', 1), '2027-01-01', 'across a year end')
    assertEq(addDays('2027-02-28', 1), '2027-03-01', 'a non-leap February has no 29th')
    assertEq(addDays('2028-02-28', 1), '2028-02-29', 'a leap February gets its 29th')
    assertEq(addDays('2026-03-01', -1), '2026-02-28', 'backwards')
    assertEq(addDays('2026-10-24', 2), '2026-10-26', 'across the October clock change')
    assertEq(weekdayIndex('2026-09-14'), 0, 'Monday → 0')
    assertEq(weekdayIndex(TODAY), 6, 'Sunday → 6')
  })

  await step('stripDays: today + the next 29 days', () => {
    const strip = stripDays(TODAY)
    assertEq(strip.length, STRIP_DAYS, `${STRIP_DAYS} pills`)
    assertEq(strip[0], TODAY, 'starts today')
    assertEq(strip[STRIP_DAYS - 1], '2026-10-12', 'ends on today + 29')
    assert(strip.every((day, i) => i === 0 || day === addDays(strip[i - 1], 1)), 'consecutive days, none skipped or repeated')

    assertEq(stripDays(TODAY, '2026-09-25'), strip, 'a picked day inside the strip changes nothing')
    const extended = stripDays(TODAY, '2026-11-20')
    assert(extended.includes('2026-11-20'), 'a picked day beyond the strip is included')
    assertEq(extended[extended.length - 1], '2026-11-26', 'and the strip runs on a week past it')
    assertEq(extended[0], TODAY, 'still starting today')
    assertEq(stripDays(TODAY, '2026-09-01'), strip, 'a day before today is ignored')
  })

  await step('weekendDays from each weekday', () => {
    const saturdayAndSunday = ['2026-09-19', '2026-09-20']
    const cases: Array<[string, string, string[]]> = [
      ['2026-09-14', 'Monday',    saturdayAndSunday],
      ['2026-09-15', 'Tuesday',   saturdayAndSunday],
      ['2026-09-16', 'Wednesday', saturdayAndSunday],
      ['2026-09-17', 'Thursday',  saturdayAndSunday],
      ['2026-09-18', 'Friday',    saturdayAndSunday],
      ['2026-09-19', 'Saturday',  saturdayAndSunday],
      ['2026-09-20', 'Sunday',    ['2026-09-20']],
    ]
    for (const [today, weekday, expected] of cases) {
      assertEq(weekendDays(today), expected, `today = ${weekday} ${today}`)
    }
    assertEq(weekendDays('2026-10-30'), ['2026-10-31', '2026-11-01'], 'a weekend split across a month end')
  })

  await step('selectionDays', () => {
    assertEq(selectionDays({ kind: 'day', day: '2026-09-20' }, TODAY), ['2026-09-20'], 'a day covers itself')
    assertEq(selectionDays({ kind: 'weekend' }, '2026-09-16'), ['2026-09-19', '2026-09-20'], 'the weekend covers Saturday + Sunday')
    assertEq(selectionDays({ kind: 'weekend' }, TODAY), [TODAY], 'on a Sunday the weekend is just today')
    assertEq(selectionDays({ kind: 'past' }, TODAY), [], '"Passés" covers no upcoming day')
  })

  await step('picker bounds: today through the same date next year', () => {
    assertEq(isPickableDay('2026-09-12', TODAY), false, 'yesterday cannot be picked')
    assertEq(isPickableDay(TODAY, TODAY), true, 'today can')
    assertEq(isPickableDay('2027-09-13', TODAY), true, `today + ${HORIZON_DAYS} days can`)
    assertEq(isPickableDay('2027-09-14', TODAY), false, 'the day after the horizon cannot')
    assertEq(lastPickerMonth(TODAY), '2027-09', 'the picker pages up to September 2027')
    assertEq(addMonths('2026-12', 1), '2027-01', 'next month across a year end')
    assertEq(addMonths('2026-01', -1), '2025-12', 'previous month across a year start')
    assertEq(addMonths('2026-09', 12), '2027-09', 'twelve months ahead')
  })

  await step('monthGrid: Monday-first, 4 to 6 rows', () => {
    // August 2026 starts on a Saturday and has 31 days → 6 rows.
    const august = checkGrid('2026-08', 6, 'August 2026 (6-row month)')
    assertEq(august[0], [null, null, null, null, null, '2026-08-01', '2026-08-02'], 'August: the 1st falls under Saturday')
    assertEq(august[5], ['2026-08-31', null, null, null, null, null, null], 'August: the 31st starts a sixth row')

    // November 2026 starts on a Sunday → the 1st sits alone at the end of row one.
    const november = checkGrid('2026-11', 6, 'November 2026 (Sunday start)')
    assertEq(november[0], [null, null, null, null, null, null, '2026-11-01'], 'November: the 1st falls under Sunday')

    // February 2026: Sunday start, 28 days → 5 rows.
    const february = checkGrid('2026-02', 5, 'February 2026')
    assertEq(february[4], ['2026-02-23', '2026-02-24', '2026-02-25', '2026-02-26', '2026-02-27', '2026-02-28', null],
      'February 2026: ends on Saturday the 28th')

    // February 2027: Monday start, 28 days → exactly 4 full rows.
    const february2027 = checkGrid('2027-02', 4, 'February 2027 (4 full rows)')
    assertEq(february2027[0][0], '2027-02-01', 'February 2027: the 1st is the first cell')
    assertEq(february2027[3][6], '2027-02-28', 'February 2027: the 28th is the last cell')

    // February 2028 is a leap year: Tuesday start, 29 days.
    const leap = checkGrid('2028-02', 5, 'February 2028 (leap year)')
    assertEq(leap[4], ['2028-02-28', '2028-02-29', null, null, null, null, null], 'February 2028: the 29th is there')
  })

  await step('eventDaySet: a dot for every day an event covers', () => {
    const festival = ev('festival', '2026-09-29', '2026-10-02')
    const days = eventDaySet([festival], TODAY, NOW)
    assertEq(Array.from(days).sort(), ['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02'],
      'a festival across a month end dots each of its four days')
    assert(!days.has('2026-09-28') && !days.has('2026-10-03'), 'and not the days either side')

    assertEq(Array.from(eventDaySet([ev('single', '2026-09-20')], TODAY, NOW)), ['2026-09-20'], 'a single-day event dots its day')

    const running = eventDaySet([ev('running', '2026-09-10', '2026-09-15')], TODAY, NOW)
    assertEq(Array.from(running).sort(), ['2026-09-13', '2026-09-14', '2026-09-15'],
      'an event already running is dotted from today on, never on past days')

    assertEq(eventDaySet([ev('past', '2026-09-01', '2026-09-05')], TODAY, NOW).size, 0, 'a finished event adds no dot')
    assertEq(eventDaySet([ev('past-single', '2026-09-12')], TODAY, NOW).size, 0, 'nor does yesterday\'s event')
  })

  await step('eventDaySet: the 365-day clamp', () => {
    const long = eventDaySet([ev('long', '2026-09-01', '2028-01-01')], TODAY, NOW)
    assertEq(long.size, HORIZON_DAYS + 1, `a year-plus event is dotted for today + ${HORIZON_DAYS} days, no further`)
    assert(long.has(TODAY) && long.has('2027-09-13'), 'from today through the horizon day')
    assert(!long.has('2027-09-14'), 'but not the day after the horizon')
    assert(!long.has('2026-09-12'), 'and not before today')
    assertEq(eventDaySet([ev('beyond', '2027-10-01', '2027-10-03')], TODAY, NOW).size, 0,
      'an event starting beyond the horizon adds no dot')
  })

  await step('eventsOnDays: festivals on each day, weekend events counted once', () => {
    const friday = '2026-09-18'
    const fridayNoon = new Date('2026-09-18T12:00:00Z')
    const events = [
      ev('sun',      '2026-09-20', null, '10:00'),
      ev('festival', '2026-09-19', '2026-09-20'),
      ev('fri',      '2026-09-18'),
      ev('sat',      '2026-09-19', null, '18:00'),
      ev('mon',      '2026-09-21'),
    ]
    assertEq(ids(eventsOnDays(events, weekendDays(friday), fridayNoon)), ['festival', 'sat', 'sun'],
      'the weekend lists the Sat–Sun festival ONCE, plus the Saturday and Sunday events, soonest start first')
    assertEq(ids(eventsOnDays(events, ['2026-09-19'], fridayNoon)), ['festival', 'sat'], 'Saturday: festival + Saturday event')
    assertEq(ids(eventsOnDays(events, ['2026-09-20'], fridayNoon)), ['festival', 'sun'], 'Sunday: the festival again + Sunday event')
    assertEq(ids(eventsOnDays(events, [friday], fridayNoon)), ['fri'], 'Friday: only its own event')

    const past = ev('past', '2026-09-01', '2026-09-05')
    assertEq(ids(eventsOnDays([past], ['2026-09-03'], NOW)), [], 'a finished event never shows, even for a day it covered')
  })

  await step('nextEventDay: the "Prochain événement" jump', () => {
    const days = new Set(['2026-10-03', '2026-09-20', '2026-10-15'])
    assertEq(nextEventDay(days, TODAY), '2026-09-20', 'from an empty today → the 20th')
    assertEq(nextEventDay(days, '2026-09-20'), '2026-10-03', 'strictly after the selected day')
    assertEq(nextEventDay(days, '2026-10-15'), null, 'nothing after the last event day')
    assertEq(nextEventDay(new Set(), TODAY), null, 'no events at all')
  })

  await step('pastEvents: most recently ended first', () => {
    const events = [
      ev('ended-sep-05', '2026-09-01', '2026-09-05'),
      ev('ended-sep-12', '2026-09-12'),
      ev('ended-aug-30', '2026-08-30'),
      ev('running',      '2026-09-10', '2026-09-15'),
      ev('upcoming',     '2026-09-20'),
    ]
    assertEq(ids(pastEvents(events, NOW)), ['ended-sep-12', 'ended-sep-05', 'ended-aug-30'],
      'ordered by the day they ended; running and upcoming events are left out')
  })

  finish(SUITE)
}

void main()
