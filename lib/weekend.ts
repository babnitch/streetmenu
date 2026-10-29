// "Ce week-end" (U3) = Friday 17:00 → Sunday 23:59, Africa/Douala time.
// Pure and client-safe: the Loisirs chips and the home row share it.
//   - Mon–Thu: the coming Friday–Sunday; Fri–Sun: this one.
//   - A Saturday or Sunday day counts. A Friday counts when the event is on
//     in the evening: no start time, a start at 17:00 or later, an end
//     after 17:00, or it carries on to Saturday.

import { addDays, weekdayIndex } from '@/lib/eventCalendar'
import { eventDays } from '@/lib/eventDate'
import { dateInZone } from '@/lib/offers'

export const WEEKEND_TZ = 'Africa/Douala'
export const WEEKEND_START = '17:00'

export function todayInDouala(at: Date = new Date()): string {
  return dateInZone(WEEKEND_TZ, at)
}

export interface WeekendWindow { fri: string; sat: string; sun: string }

export function weekendWindow(today: string): WeekendWindow {
  const wd = weekdayIndex(today)                 // 0 = Monday … 6 = Sunday
  const fri = wd <= 4 ? addDays(today, 4 - wd) : addDays(today, -(wd - 4))
  return { fri, sat: addDays(fri, 1), sun: addDays(fri, 2) }
}

export interface WeekendEventShape { date: string; end_date?: string | null; time?: string | null; end_time?: string | null }

// Does the event fill the Friday evening (when it is on that Friday)?
export function onFridayEvening(e: WeekendEventShape, fri: string): boolean {
  const lastDay = e.end_date ?? e.date
  if (lastDay > fri) return true                 // carries on to Saturday
  if (e.date < fri && lastDay >= fri) return true
  if (!e.time) return true
  if (e.time >= WEEKEND_START) return true
  return !!e.end_time && e.end_time > WEEKEND_START
}

// The first weekend day of `days` (the event's upcoming days) that counts,
// else null.
export function weekendDay(e: WeekendEventShape, days: string[], w: WeekendWindow): string | null {
  for (const d of days) {
    if (d === w.sat || d === w.sun) return d
    if (d === w.fri && onFridayEvening(e, w.fri)) return d
  }
  return null
}

// Today → the last day of this month (for "Ce mois").
export function restOfMonth(today: string): string[] {
  const out: string[] = []
  for (let d = today; d.slice(0, 7) === today.slice(0, 7); d = addDays(d, 1)) out.push(d)
  return out
}

// A listing event's upcoming days: the days it sells (with seats), else its
// dates from today on. Shared by Loisirs and the home "Ce week-end" row.
export function listingDays(
  e: WeekendEventShape & { days?: Array<{ date: string }> | null },
  today: string,
): string[] {
  return e.days && e.days.length ? e.days.map(d => d.date) : eventDays(e as never).filter(d => d >= today)
}
