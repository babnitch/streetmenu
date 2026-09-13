// Event dates — "is it past?", "is it on day X?", and the date-range formatter
// (lib/eventDate.ts).
//
// Pure: no server, no DB, no cleanup. Every "past" case pins `now`, so the
// result never depends on when the suite runs.
//
// Reference instant: 2026-01-18T12:00:00Z → today is 2026-01-18 (UTC).
//
// This is the logic that gates bookings. Getting it wrong either refuses a
// valid booking on an ongoing multi-day event or sells tickets to one that has
// finished, so both directions are pinned below.

import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative, resolve } from 'path'
import {
  EVENT_DATE_COLUMNS,
  EVENT_RANGE_ERRORS,
  effectiveEndDate,
  eventRangeErrorText,
  normalizeEndDate,
  validateEventRange,
  eventSpansDay,
  formatEventDates,
  formatEventEnd,
  formatEventWhen,
  isMultiDay,
  isPastEvent,
  todayISO,
  type EventDateStyle,
  type EventWhen,
} from '@/lib/eventDate'
import { assert, assertEq, step, finish } from '../testkit/assert'

const SUITE = 'unit-event-date'
const NOW = new Date('2026-01-18T12:00:00Z')

// The exact Intl options each group of call sites used before the helper
// existed — single-day output must still match them.
const LEGACY_OPTIONS: Record<EventDateStyle, Intl.DateTimeFormatOptions> = {
  card:       { day: '2-digit', month: 'short', year: 'numeric' },
  detail:     { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' },
  message:    { day: '2-digit', month: 'long', year: 'numeric' },
  list:       { weekday: 'short', day: '2-digit', month: 'short' },
  compact:    { day: '2-digit', month: 'short' },
  chatDetail: { weekday: 'short', day: '2-digit', month: 'long', year: 'numeric' },
}

// Intl puts thin spaces around the dash in some ranges — spelled out so the
// expectations below are unambiguous.
const THIN_DASH = ' – '

function ev(date: string | null, endDate: string | null = null, time: string | null = null, endTime: string | null = null): EventWhen {
  return { id: 'test', date, end_date: endDate, time, end_time: endTime }
}

// A row whose select forgot end_date entirely — the key is absent, not NULL.
function rowWithoutEndDate(date: string): EventWhen {
  return { id: 'no-end-key', date } as unknown as EventWhen
}

// Compile-time only, never called. isPastEvent takes the event row so the
// compiler rejects any gate still judging an event by its start date — if
// either call below ever type-checks again, tsc fails on the unused directive.
export function bareDatesDoNotCompile(): void {
  // @ts-expect-error — a bare date cannot say when a multi-day event ends
  isPastEvent('2026-01-17', NOW)
  // @ts-expect-error — a row selected without end_date is not an EventWhen
  isPastEvent({ date: '2026-01-17' }, NOW)
}

// Every .ts/.tsx file under dir.
function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path))
    else if (/\.tsx?$/.test(name)) out.push(path)
  }
  return out
}

// Shapes that judge an event by its START date. The compiler cannot catch them:
// Supabase rows are untyped `any`, so isPastEvent(row.date) still type-checks.
// This scan is the standing guard that keeps them from coming back.
const START_DATE_SHAPES: Array<{ label: string; pattern: RegExp }> = [
  { label: 'isPastEvent(<x>.date)', pattern: /isPastEvent\([^)]*\.date\b/ },
  { label: ".gte('date', …)",       pattern: /\.gte\(\s*['"`]date['"`]/ },
]

// Runs fn with console.error captured, so the missing-key guard can be asserted
// without printing into the suite output.
function captureErrors<T>(fn: () => T): { result: T; errors: string[] } {
  const original = console.error
  const errors: string[] = []
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')) }
  try {
    return { result: fn(), errors }
  } finally {
    console.error = original
  }
}

async function main(): Promise<void> {
  await step('today is the UTC date', () => {
    assertEq(todayISO(NOW), '2026-01-18', 'noon UTC')
    // 00:30 the next day in Douala (UTC+1) — still the 18th: lenient by up to an hour.
    assertEq(todayISO(new Date('2026-01-18T23:30:00Z')), '2026-01-18', 'late evening UTC is still the same day')
  })

  await step('single-day events', () => {
    assertEq(isPastEvent(ev('2026-01-17'), NOW), true, 'yesterday → past')
    assertEq(isPastEvent(ev('2026-01-18'), NOW), false, 'today → NOT past (bookable all day)')
    assertEq(isPastEvent(ev('2026-01-19'), NOW), false, 'tomorrow → not past')
  })

  await step('multi-day events are past only once the LAST day is over', () => {
    assertEq(isPastEvent(ev('2026-01-16', '2026-01-19'), NOW), false,
      'ongoing: started 2 days ago, ends tomorrow → NOT past')
    assertEq(isPastEvent(ev('2026-01-15', '2026-01-18'), NOW), false,
      'last day is today → NOT past')
    assertEq(isPastEvent(ev('2026-01-13', '2026-01-17'), NOW), true,
      'finished: last day was yesterday → past')
    assertEq(isPastEvent(ev('2026-01-19', '2026-01-21'), NOW), false,
      'starts tomorrow → not past')
  })

  await step('end_date NULL falls back to date', () => {
    assertEq(effectiveEndDate(ev('2026-01-17')), '2026-01-17', 'NULL end_date → the start date')
    assertEq(effectiveEndDate(ev('2026-01-16', '2026-01-19')), '2026-01-19', 'set end_date wins')
    assertEq(effectiveEndDate(ev('2026-01-16T00:00:00+00:00', '2026-01-19T00:00:00+00:00')), '2026-01-19',
      'timestamp-shaped values are cut to the day')
    assertEq(isPastEvent(ev('2026-01-17', null), NOW), true, 'NULL end_date, date yesterday → past')

    const { errors } = captureErrors(() => isPastEvent(ev('2026-01-17', null), NOW))
    assertEq(errors.length, 0, 'a present-but-NULL end_date is normal and does NOT log')
  })

  await step('missing end_date KEY falls back to date AND logs', () => {
    const past = captureErrors(() => isPastEvent(rowWithoutEndDate('2026-01-16'), NOW))
    assertEq(past.result, true, 'falls back to date (the 16th) → past')
    assertEq(past.errors.length, 1, 'logs exactly once')
    assert(past.errors[0]?.includes('end_date'), 'the log names the missing end_date key', past.errors[0])
    assert(past.errors[0]?.includes('no-end-key'), 'the log names the event id', past.errors[0])

    const end = captureErrors(() => effectiveEndDate(rowWithoutEndDate('2026-01-16')))
    assertEq(end.result, '2026-01-16', 'effectiveEndDate falls back to date')
    assertEq(end.errors.length, 1, 'effectiveEndDate logs too')
  })

  await step('missing or unparseable dates are never past', () => {
    assertEq(isPastEvent(ev(null), NOW), false, 'NULL date → not past')
    assertEq(isPastEvent(ev('soon'), NOW), false, 'garbage date → not past')
    assertEq(isPastEvent(ev('2026-01-16', 'garbage'), NOW), true, 'garbage end_date → falls back to date')
  })

  await step('eventSpansDay', () => {
    const festival = ev('2026-01-17', '2026-01-19')
    assertEq(eventSpansDay(festival, '2026-01-16'), false, 'day before → no')
    assertEq(eventSpansDay(festival, '2026-01-17'), true, 'first day → yes')
    assertEq(eventSpansDay(festival, '2026-01-18'), true, 'middle day → yes')
    assertEq(eventSpansDay(festival, '2026-01-19'), true, 'last day → yes')
    assertEq(eventSpansDay(festival, '2026-01-20'), false, 'day after → no')

    const single = ev('2026-01-17')
    assertEq(eventSpansDay(single, '2026-01-17'), true, 'single-day: its day → yes')
    assertEq(eventSpansDay(single, '2026-01-18'), false, 'single-day: next day → no')
    assertEq(eventSpansDay(ev(null), '2026-01-17'), false, 'NULL date → never')

    const missing = captureErrors(() => eventSpansDay(rowWithoutEndDate('2026-01-17'), '2026-01-18'))
    assertEq(missing.result, false, 'missing end_date key → treated as single-day')
    assertEq(missing.errors.length, 1, 'and logs')
  })

  await step('formatEventWhen / formatEventDates: single-day output matches the pre-range formatting', () => {
    for (const lang of ['fr', 'en'] as const) {
      const locale = lang === 'en' ? 'en-GB' : 'fr-FR'
      for (const style of Object.keys(LEGACY_OPTIONS) as EventDateStyle[]) {
        const before = new Date('2026-01-17').toLocaleDateString(locale, { ...LEGACY_OPTIONS[style], timeZone: 'UTC' })
        assertEq(formatEventWhen(ev('2026-01-17'), lang, style), before, `${lang} ${style} unchanged (when)`)
        assertEq(formatEventDates(ev('2026-01-17', null, '18:00'), lang, style), before, `${lang} ${style} unchanged (dates)`)
      }
    }
  })

  await step('formatEventDates: dates without times', () => {
    assertEq(formatEventDates(ev('2026-01-17', null, '18:00', '23:00'), 'fr', 'message'), '17 janvier 2026',
      'single day drops both times')
    assertEq(formatEventDates(ev('2026-01-17', '2026-01-19', '18:00'), 'fr', 'compact'), '17–19 janv.',
      'same month, FR compact')
    assertEq(formatEventDates(ev('2026-01-30', '2026-02-02', '18:00'), 'fr', 'message'), `30 janvier${THIN_DASH}2 février 2026`,
      'across a month, FR message')
    assertEq(formatEventDates(ev(null), 'fr', 'card'), '', 'NULL date → empty string')
  })

  await step('isMultiDay', () => {
    assertEq(isMultiDay(ev('2026-01-17')), false, 'NULL end_date → single day')
    assertEq(isMultiDay(ev('2026-01-17', '2026-01-17')), false, 'end_date equal to date → single day')
    assertEq(isMultiDay(ev('2026-01-17', '2026-01-19')), true, 'range → multi-day')
    assertEq(isMultiDay(ev(null, '2026-01-19')), false, 'NULL date → not multi-day')
  })

  await step('formatEventWhen: times', () => {
    assertEq(formatEventWhen(ev('2026-01-17', null, '18:00'), 'fr', 'card'), '17 janv. 2026 · 18:00', 'start time')
    assertEq(formatEventWhen(ev('2026-01-17', null, '18:00', '23:00'), 'fr', 'card'), '17 janv. 2026 · 18:00–23:00',
      'single day with start and end time')
    assertEq(formatEventWhen(ev('2026-01-17', '2026-01-17', '18:00'), 'fr', 'card'), '17 janv. 2026 · 18:00',
      'end_date equal to date is single-day')
    assertEq(formatEventWhen(ev('2026-01-17', null, null, '23:00'), 'fr', 'card'), '17 janv. 2026',
      'end time without a start time is not shown')
    assertEq(formatEventWhen(ev(null, null, '18:00'), 'fr', 'card'), '', 'NULL date → empty string')
  })

  await step('formatEventWhen: multi-day ranges', () => {
    assertEq(formatEventWhen(ev('2026-01-17', '2026-01-19', '18:00', '23:00'), 'fr', 'card'), '17–19 janv. 2026 · 18:00',
      'same month, FR card — start time only')
    assertEq(formatEventWhen(ev('2026-01-30', '2026-02-02'), 'fr', 'card'), `30 janv.${THIN_DASH}2 févr. 2026`,
      'across a month, FR card')
    assertEq(formatEventWhen(ev('2026-12-30', '2027-01-02'), 'fr', 'message'), `30 décembre 2026${THIN_DASH}2 janvier 2027`,
      'across a year, FR message')
    assertEq(formatEventWhen(ev('2026-01-17', '2026-01-19', '18:00'), 'en', 'card'), `17${THIN_DASH}19 Jan 2026 · 18:00`,
      'same month, EN card')
    assertEq(formatEventWhen(ev('2026-01-17', '2026-01-19'), 'fr', 'detail'), `samedi 17${THIN_DASH}lundi 19 janvier 2026`,
      'same month, FR detail with weekdays')
  })

  await step('formatEventEnd', () => {
    assertEq(formatEventEnd(ev('2026-01-17', null, '18:00', '23:00'), 'fr', 'card'), null, 'single-day → null')
    assertEq(formatEventEnd(ev('2026-01-17', '2026-01-17'), 'fr', 'card'), null, 'end_date equal to date → null')
    assertEq(formatEventEnd(ev('2026-01-17', '2026-01-19', '18:00', '23:00'), 'fr', 'card'), '19 janv. 2026 · 23:00',
      'multi-day with end time')
    assertEq(formatEventEnd(ev('2026-01-17', '2026-01-19'), 'fr', 'detail'), 'lundi 19 janvier 2026',
      'multi-day without end time')
  })

  await step('validateEventRange', () => {
    const check = (date: string | null, time: string | null, endDate: string | null, endTime: string | null) =>
      validateEventRange({ date, time, end_date: endDate, end_time: endTime })

    assertEq(check('2026-01-17', null, null, null), null, 'single day, no times')
    assertEq(check('2026-01-17', '', '', ''), null, 'blank strings count as unset')
    assertEq(check('2026-01-17', '18:00', null, '23:00'), null, 'single day, 18:00–23:00')
    assertEq(check('2026-01-17', '18:00', null, '18:00'), null, 'end time equal to start time is allowed')
    assertEq(check('2026-01-17', '18:00', '2026-01-19', '02:00'), null,
      'multi-day: an end time before the start time is fine on a later day')

    assertEq(check('2026-01-17', null, '2026-01-16', null), 'end_before_start', 'end date before start → refused')
    assertEq(check('2026-01-17', '22:00', null, '03:00'), 'end_time_before_start',
      'overnight with no end date → refused, not moved to the next day')
    assertEq(check('2026-01-17', '22:00', '2026-01-17', '03:00'), 'end_time_before_start',
      'overnight with the end date equal to the start → refused too')
    assertEq(check('2026-01-17', '22:00', '2026-01-18', '03:00'), null,
      'overnight with the next day as end date → accepted')
    assertEq(check('2026-01-17', null, null, '23:00'), 'end_time_without_start', 'end time without a start time → refused')

    assertEq(check(null, null, null, null), 'bad_format', 'no start date → bad_format')
    assertEq(check('17/01/2026', null, null, null), 'bad_format', 'non-ISO date → bad_format')
    assertEq(check('2026-02-31', null, null, null), 'bad_format', 'impossible calendar date → bad_format')
    assertEq(check('2026-01-17', '6pm', null, null), 'bad_format', 'non-HH:MM time → bad_format')
    assertEq(check('2026-01-17T00:00:00+00:00', null, '2026-01-19T00:00:00+00:00', null), null,
      'timestamp-shaped DB values are cut to the day')

    assert(eventRangeErrorText('end_time_before_start').includes('next day'), 'the overnight error tells them to use the next day (EN)')
    assert(EVENT_RANGE_ERRORS.end_time_before_start.fr.includes('lendemain'), 'and in French')
  })

  await step('normalizeEndDate: only a later day is stored', () => {
    assertEq(normalizeEndDate('2026-01-17', '2026-01-19'), '2026-01-19', 'a later day is kept')
    assertEq(normalizeEndDate('2026-01-17', '2026-01-17'), null, 'the same day → NULL (single-day)')
    assertEq(normalizeEndDate('2026-01-17', null), null, 'no end → NULL')
    assertEq(normalizeEndDate('2026-01-17', ''), null, 'blank end → NULL')
    assertEq(normalizeEndDate('2026-01-17', '2026-01-16'), null, 'an earlier day is never stored')
  })

  await step('EVENT_DATE_COLUMNS carries the whole range', () => {
    const cols = EVENT_DATE_COLUMNS.split(',').map(c => c.trim())
    for (const col of ['date', 'time', 'end_date', 'end_time']) {
      assert(cols.includes(col), `includes ${col}`, EVENT_DATE_COLUMNS)
    }
  })

  await step('source scan: no gate in app/ or lib/ judges an event by its start date', () => {
    // Positive controls first — a clean scan proves nothing unless the
    // patterns demonstrably match the old shapes.
    const [pastByDate, gteDate] = START_DATE_SHAPES
    assert(pastByDate.pattern.test('if (isPastEvent(event.date)) {'), 'control: detects isPastEvent(event.date)')
    assert(pastByDate.pattern.test('.filter(e => !isPastEvent(e.date))'), 'control: detects isPastEvent(e.date) in a filter')
    assert(!pastByDate.pattern.test('if (isPastEvent(event)) {'), 'control: isPastEvent(event) is allowed')
    assert(gteDate.pattern.test(".gte('date', today)"), "control: detects .gte('date', today)")
    assert(!gteDate.pattern.test(".gte('effective_end_date', today)"), "control: .gte('effective_end_date', …) is allowed")

    const root = process.cwd()
    const files = [...sourceFiles(resolve(root, 'app')), ...sourceFiles(resolve(root, 'lib'))]
    assert(files.length > 50, `scanned app/ + lib/ (${files.length} files)`)

    for (const { label, pattern } of START_DATE_SHAPES) {
      const hits: string[] = []
      for (const file of files) {
        readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
          if (pattern.test(line)) hits.push(`${relative(root, file)}:${i + 1}`)
        })
      }
      assertEq(hits, [], `no ${label} anywhere in app/ or lib/`)
    }
  })

  finish(SUITE)
}

void main()
