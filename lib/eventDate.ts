// Single source of truth for "is this event over?".
//
// events.date is a DATE column (YYYY-MM-DD) and events.time is free text, so
// the comparison is date-only: an event is past once its date is strictly
// before today. An event happening *today* is still bookable all day — the
// organizer closes it with "fermer reservations" if they want to cut it off
// earlier. Both sides (server routes + client pages) import from here so the
// public list, the detail page, the reserve APIs and the WhatsApp flow can
// never disagree about what counts as past.

export function todayISO(): string {
  return new Date().toISOString().slice(0, 10)
}

// Accepts anything the DB hands back for events.date (string | Date | null).
// Null/undefined/unparseable dates are treated as NOT past — a missing date
// should never silently block a booking.
export function isPastEvent(date: string | Date | null | undefined): boolean {
  if (!date) return false
  const iso = typeof date === 'string' ? date.slice(0, 10) : date.toISOString().slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false
  return iso < todayISO()
}

// Bilingual copy for the "this event is over" state. Kept next to the
// predicate so the wording stays consistent across the web pages, the API
// error bodies and the WhatsApp replies.
export const PAST_EVENT_MESSAGE_FR = 'Cet événement est passé'
export const PAST_EVENT_MESSAGE_EN = 'This event has passed'
export const PAST_EVENT_ERROR = `${PAST_EVENT_MESSAGE_FR} / ${PAST_EVENT_MESSAGE_EN}`
