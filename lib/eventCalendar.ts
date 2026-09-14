// Calendar maths for the Events tab: the day strip, the month picker grid and
// the per-day event dots. Pure — no UI, and the
// clock only enters through the `today` / `now` arguments — so every boundary
// is unit-tested (scripts/suites/unit-event-calendar.ts).
//
// Days are YYYY-MM-DD strings. Whether an event is on a day, when it ends and
// whether it is over all come from lib/eventDate.ts; this file only walks days.
//
// "Today" here is the phone's LOCAL date — what "Aujourd'hui" means to the
// person holding it. The booking gates keep their UTC "today"; the two differ
// by at most an hour in the cities served, and an event on a day on or after
// local today is never UTC-past, so they cannot disagree about what is shown.

import { eventDayRange, eventSpansDay, isPastEvent, type EventWhen } from '@/lib/eventDate'

// Pills in the day strip, starting with today.
export const STRIP_DAYS = 30
// How far ahead both the picker and the event dots reach: through the same
// date next year. One horizon, so a pickable day never lacks its dot.
export const HORIZON_DAYS = 365

export type DaySelection =
  | { kind: 'day'; day: string }
  | { kind: 'past' }

// ── Days ─────────────────────────────────────────────────────────────────────

// The phone's local calendar day.
export function localDayISO(now: Date = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function utcMidnight(day: string): Date {
  return new Date(`${day}T00:00:00Z`)
}

// Day arithmetic in UTC, so a daylight-saving change never skips or repeats a day.
export function addDays(day: string, n: number): string {
  const d = utcMidnight(day)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

// 0 = Monday … 6 = Sunday.
export function weekdayIndex(day: string): number {
  return (utcMidnight(day).getUTCDay() + 6) % 7
}

// Every day from `from` to `to`, both included. Empty when `to` is earlier.
export function daysBetween(from: string, to: string): string[] {
  const days: string[] = []
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(d)
  return days
}

// The day strip: today and the following STRIP_DAYS - 1 days. When a date
// picked in the calendar lies beyond that, the strip runs on to a week past
// it, so the picked pill has neighbours to scroll between.
export function stripDays(today: string, selectedDay?: string | null): string[] {
  let last = addDays(today, STRIP_DAYS - 1)
  if (selectedDay && selectedDay > last) last = addDays(selectedDay, 6)
  return daysBetween(today, last)
}

// The days a selection covers. The past-events list covers no upcoming day.
export function selectionDays(selection: DaySelection): string[] {
  return selection.kind === 'day' ? [selection.day] : []
}

// Whether the picker lets this day be chosen: today through HORIZON_DAYS ahead.
export function isPickableDay(day: string, today: string): boolean {
  return day >= today && day <= addDays(today, HORIZON_DAYS)
}

// ── Months ───────────────────────────────────────────────────────────────────

// YYYY-MM of a day.
export function monthOf(day: string): string {
  return day.slice(0, 7)
}

export function addMonths(month: string, n: number): string {
  const [year, monthNumber] = month.split('-').map(Number)
  const index = year * 12 + (monthNumber - 1) + n
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`
}

// The last month the picker can page to: the one holding the horizon day.
export function lastPickerMonth(today: string): string {
  return monthOf(addDays(today, HORIZON_DAYS))
}

// A Monday-first month grid: rows of 7 with the days of `month` (YYYY-MM) in
// place and null where a row runs into the neighbouring months. 4 to 6 rows.
export function monthGrid(month: string): Array<Array<string | null>> {
  const first = `${month}-01`
  const [year, monthNumber] = month.split('-').map(Number)
  const daysInMonth = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate()

  const cells = new Array<string | null>(weekdayIndex(first)).fill(null)
  for (let i = 0; i < daysInMonth; i++) cells.push(addDays(first, i))
  while (cells.length % 7 !== 0) cells.push(null)

  const rows: Array<Array<string | null>> = []
  for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7))
  return rows
}

// ── Events per day ───────────────────────────────────────────────────────────

// Every day, from today through the horizon, with at least one event on it —
// the dots under the strip pills and the picker days. A festival adds a dot
// for each day it covers; one already running only from today on.
export function eventDaySet(events: EventWhen[], today: string, now: Date = new Date()): Set<string> {
  const horizon = addDays(today, HORIZON_DAYS)
  const days = new Set<string>()
  for (const event of events) {
    if (isPastEvent(event, now)) continue
    const range = eventDayRange(event)
    if (!range) continue
    const from = range.start > today ? range.start : today
    const to   = range.end < horizon ? range.end : horizon
    for (const day of daysBetween(from, to)) days.add(day)
  }
  return days
}

// The events on any of `days`, each listed once — a festival covering several
// of them is not doubled — soonest start first. Finished events never show.
export function eventsOnDays<T extends EventWhen>(events: T[], days: string[], now: Date = new Date()): T[] {
  return events
    .filter(event => !isPastEvent(event, now) && days.some(day => eventSpansDay(event, day)))
    .sort(bySoonestStart)
}

function bySoonestStart(a: EventWhen, b: EventWhen): number {
  const aStart = eventDayRange(a)?.start ?? ''
  const bStart = eventDayRange(b)?.start ?? ''
  return aStart.localeCompare(bStart) || (a.time ?? '').localeCompare(b.time ?? '')
}

// The first day after `after` that has an event — the "Prochain événement →" jump.
export function nextEventDay(eventDays: Set<string>, after: string): string | null {
  let next: string | null = null
  for (const day of Array.from(eventDays)) {
    if (day > after && (next === null || day < next)) next = day
  }
  return next
}

// Finished events, most recently ended first — the "Passés" pill.
export function pastEvents<T extends EventWhen>(events: T[], now: Date = new Date()): T[] {
  return events
    .filter(event => isPastEvent(event, now))
    .sort((a, b) => (eventDayRange(b)?.end ?? '').localeCompare(eventDayRange(a)?.end ?? ''))
}
