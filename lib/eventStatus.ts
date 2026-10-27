// Events listing (Ticketcorner-style redesign, E1) — the pure rules shared by
// GET /api/events/listing and the pages. No database, no React.

// One upcoming day of an event, as the listing sends it.
export interface ListingDay {
  date:      string          // YYYY-MM-DD
  capacity:  number          // 0 = unlimited
  sold:      number
  remaining: number | null   // null = unlimited
  soldOut:   boolean
  minPrice:  number | null   // cheapest tier still available that day (or the single price); null = nothing to sell
}

export type EventStatus =
  | { kind: 'sold_out' }                              // every upcoming day full
  | { kind: 'sold_out_day'; day: string }             // the shown day full, another day not
  | { kind: 'few'; left: number }                     // "Plus que N places"
  | { kind: 'busy' }                                  // "Beaucoup de réservations"
  | null

export const FEW_SEATS_MAX      = 10    // "Plus que N places" when N ≤ 10 …
export const FEW_SEATS_SHARE    = 0.2   // … or N ≤ 20 % of the day's capacity
export const BUSY_SHARE         = 0.6   // "Beaucoup de réservations" at ≥ 60 % taken (limited)
export const BUSY_RECENT_SEATS  = 20    // … or ≥ 20 seats booked in 7 days (unlimited)

// The one status line for an event row, for the day it is shown for. First
// match wins: all full → that day full → few seats → busy → nothing.
export function eventStatus(days: ListingDay[], shownDay: string | null, recentSeats7d: number): EventStatus {
  if (days.length === 0) return null
  if (days.every(d => d.soldOut)) return { kind: 'sold_out' }
  const d = (shownDay && days.find(x => x.date === shownDay)) || days[0]
  if (d.soldOut) return { kind: 'sold_out_day', day: d.date }
  if (d.remaining !== null && d.capacity > 0
      && (d.remaining <= FEW_SEATS_MAX || d.remaining <= d.capacity * FEW_SEATS_SHARE)) {
    return { kind: 'few', left: d.remaining }
  }
  if (d.capacity > 0 ? d.sold >= d.capacity * BUSY_SHARE : recentSeats7d >= BUSY_RECENT_SEATS) {
    return { kind: 'busy' }
  }
  return null
}

// "Épuisé aujourd'hui · autres dates dispo", "Plus que 4 places", …
export function statusText(s: EventStatus, today: string, lang: 'fr' | 'en', dayLabel: (iso: string) => string): string | null {
  if (!s) return null
  switch (s.kind) {
    case 'sold_out':
      return lang === 'en' ? 'Sold out' : 'Épuisé'
    case 'sold_out_day': {
      const when = s.day === today
        ? (lang === 'en' ? 'today' : 'aujourd\'hui')
        : (lang === 'en' ? `on ${dayLabel(s.day)}` : `le ${dayLabel(s.day)}`)
      return lang === 'en' ? `Sold out ${when} · other dates available` : `Épuisé ${when} · autres dates dispo`
    }
    case 'few':
      return lang === 'en' ? `Only ${s.left} ${s.left === 1 ? 'seat' : 'seats'} left` : `Plus que ${s.left} ${s.left === 1 ? 'place' : 'places'}`
    case 'busy':
      return lang === 'en' ? 'Lots of bookings' : 'Beaucoup de réservations'
  }
}

// "Dès X FCFA" / "Gratuit": the lowest price over the days still on sale.
export function fromPrice(days: ListingDay[]): number | null {
  const prices = days.filter(d => !d.soldOut && d.minPrice !== null).map(d => d.minPrice as number)
  return prices.length ? Math.min(...prices) : null
}

// "À la une": admin pick (soonest) → active paid promotion → most bookings
// (→ the soonest event when nobody has booked yet).
export function pickFeatured(
  events: Array<{ id: string; is_featured: boolean; firstDay: string | null; bookings30d: number }>,
  promotedIds: string[],
): string | null {
  const live = events.filter(e => e.firstDay)
  const admin = live.filter(e => e.is_featured).sort((a, b) => (a.firstDay as string).localeCompare(b.firstDay as string))[0]
  if (admin) return admin.id
  const paid = promotedIds.find(id => live.some(e => e.id === id))
  if (paid) return paid
  const best = [...live].sort((a, b) => b.bookings30d - a.bookings30d)[0]
  if (best && best.bookings30d > 0) return best.id
  // No booking anywhere yet: the soonest upcoming event, so the slot is
  // never empty while there are events.
  return [...live].sort((a, b) => (a.firstDay as string).localeCompare(b.firstDay as string))[0]?.id ?? null
}
