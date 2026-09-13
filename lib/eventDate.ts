// Single source of truth for event dates: "is this event over?", "is it on
// day X?", and how its date range is printed.
//
// events.date (DATE) + events.time (HH:MM text) are the START.
// events.end_date (DATE, NULL = single-day) + events.end_time are the END, and
// the DB exposes effective_end_date = COALESCE(end_date, date) for queries
// (supabase-event-date-range.sql).
//
// Comparisons are date-only: an event is past once its LAST day is strictly
// before today. An ongoing multi-day event is therefore still bookable, and an
// event ending *today* stays bookable all day — the organizer closes it with
// "fermer reservations" if they want to cut it off earlier. Server routes,
// client pages and the WhatsApp flow all import from here so the public list,
// the detail page, the reserve APIs and the WhatsApp flow can never disagree
// about what counts as past.
//
// "Today" is the UTC date. Every city served is UTC+0 or UTC+1, so it lags
// local time by at most an hour, on the lenient side.

// Every select that feeds the helpers below must include these columns.
export const EVENT_DATE_COLUMNS = 'date, time, end_date, end_time'

export interface EventWhen {
  id?: string
  date: string | null
  // A required key even when NULL: a row selected without end_date would make
  // a multi-day event look like it ended on its first day.
  end_date: string | null
  time?: string | null
  end_time?: string | null
}

type BareDate = string | Date | null | undefined

// YYYY-MM-DD, or null when missing/unparseable. Accepts anything the DB hands
// back for a DATE column (string | Date | null).
function toISODate(value: BareDate): string | null {
  if (!value) return null
  const iso = typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : null
}

export function todayISO(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10)
}

// Last day of the event (YYYY-MM-DD): end_date, or date for a single-day event.
//
// A row with no end_date KEY at all means its select forgot EVENT_DATE_COLUMNS.
// Log it loudly and fall back to date: that can only end a multi-day event
// early (refusing a valid booking), never keep a finished one open.
export function effectiveEndDate(event: EventWhen): string | null {
  const start = toISODate(event.date)
  // Read before the key check: the type says end_date is always present, so
  // TypeScript narrows `event` to never inside the branch.
  const id = event.id ?? '?'
  if (!('end_date' in event)) {
    console.error('[eventDate] event %s has no end_date key — its select is missing EVENT_DATE_COLUMNS; falling back to date', id)
    return start
  }
  return toISODate(event.end_date) ?? start
}

// Null/undefined/unparseable dates are treated as NOT past — a missing date
// should never silently block a booking.
//
// Takes the event row, never a bare date: a bare date cannot say when a
// multi-day event ends, so the compiler rejects any caller passing one.
export function isPastEvent(event: EventWhen, now: Date = new Date()): boolean {
  const lastDay = effectiveEndDate(event)
  if (!lastDay) return false
  return lastDay < todayISO(now)
}

// Whether the event is on the given day (YYYY-MM-DD), first and last day included.
export function eventSpansDay(event: EventWhen, dayISO: string): boolean {
  const start = toISODate(event.date)
  const end = effectiveEndDate(event)
  if (!start || !end) return false
  return start <= dayISO && dayISO <= end
}

// ── Display ───────────────────────────────────────────────────────────────────

export type EventDateStyle = 'card' | 'detail' | 'message' | 'list' | 'compact' | 'chatDetail'

// Each style reproduces the Intl options its call sites used before this
// helper existed, so single-day events print exactly as they always have.
const STYLE_OPTIONS: Record<EventDateStyle, Intl.DateTimeFormatOptions> = {
  card:       { day: '2-digit', month: 'short', year: 'numeric' },                   // web cards, admin, account, broadcasts
  detail:     { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' },   // web event detail page
  message:    { day: '2-digit', month: 'long', year: 'numeric' },                    // WhatsApp confirmations
  list:       { weekday: 'short', day: '2-digit', month: 'short' },                  // WhatsApp events list
  compact:    { day: '2-digit', month: 'short' },                                    // WhatsApp "mes ..." lists
  chatDetail: { weekday: 'short', day: '2-digit', month: 'long', year: 'numeric' },  // WhatsApp event detail card
}

function utcDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d))
}

// timeZone UTC: these are calendar days, not instants. Formatting them in the
// viewer's zone would show the previous day to anyone west of UTC.
function dateFormatter(lang: 'fr' | 'en', style: EventDateStyle): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(lang === 'en' ? 'en-GB' : 'fr-FR', { ...STYLE_OPTIONS[style], timeZone: 'UTC' })
}

interface DayRange { start: string; end: string }

// First and last day (YYYY-MM-DD) of the event, or null without a start date.
// Computed once per call so the missing-key guard logs at most once.
function dayRange(event: EventWhen): DayRange | null {
  const start = toISODate(event.date)
  if (!start) return null
  return { start, end: effectiveEndDate(event) ?? start }
}

// Whether the event covers more than one calendar day.
export function isMultiDay(event: EventWhen): boolean {
  const range = dayRange(event)
  return !!range && range.end !== range.start
}

function formatDays(range: DayRange, lang: 'fr' | 'en', style: EventDateStyle): string {
  const fmt = dateFormatter(lang, style)
  return range.end === range.start
    ? fmt.format(utcDate(range.start))
    : fmt.formatRange(utcDate(range.start), utcDate(range.end))
}

// Dates only: "17 janv. 2026" or "17–19 janv. 2026". For the messages and
// lists that have never shown a time.
export function formatEventDates(event: EventWhen, lang: 'fr' | 'en', style: EventDateStyle): string {
  const range = dayRange(event)
  return range ? formatDays(range, lang, style) : ''
}

// Dates + time. Single day: "17 janv. 2026 · 18:00–23:00". Range:
// "17–19 janv. 2026 · 18:00" — a range shows only its start time; the end goes
// on its own line through formatEventEnd.
export function formatEventWhen(event: EventWhen, lang: 'fr' | 'en', style: EventDateStyle): string {
  const range = dayRange(event)
  if (!range) return ''
  const hours = range.end !== range.start
    ? event.time ?? ''
    : event.time ? (event.end_time ? `${event.time}–${event.end_time}` : event.time) : ''
  return formatDays(range, lang, style) + (hours ? ` · ${hours}` : '')
}

// Last day (+ end time) of a multi-day event, for a "Fin :" line. Null for a
// single-day event, whose end time is already in formatEventWhen's output.
export function formatEventEnd(event: EventWhen, lang: 'fr' | 'en', style: EventDateStyle): string | null {
  const range = dayRange(event)
  if (!range || range.end === range.start) return null
  return dateFormatter(lang, style).format(utcDate(range.end)) + (event.end_time ? ` · ${event.end_time}` : '')
}

// Bilingual copy for the "this event is over" state. Kept next to the
// predicate so the wording stays consistent across the web pages, the API
// error bodies and the WhatsApp replies.
export const PAST_EVENT_MESSAGE_FR = 'Cet événement est passé'
export const PAST_EVENT_MESSAGE_EN = 'This event has passed'
export const PAST_EVENT_ERROR = `${PAST_EVENT_MESSAGE_FR} / ${PAST_EVENT_MESSAGE_EN}`
