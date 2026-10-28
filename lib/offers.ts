// Offer of the day (V2). Pure and client-safe: the dashboard form, the API
// and the pricing share one copy of the rules.
//
// Two kinds, stored in menu_offers:
//   - 'price':         one dish at offer_price, from starts_on to ends_on;
//   - 'free_delivery': the restaurant's delivery fee is 0 on those days.
// Days are the restaurant's own (restaurants.timezone, else the city's zone,
// else Africa/Douala), so an offer ends by itself at local midnight after
// ends_on — nothing has to switch it off.

import { timezoneForCity } from '@/lib/openingHours'

export type OfferKind = 'price' | 'free_delivery'

export const OFFER_MAX_SPAN_DAYS = 60   // same bound as the DB CHECK
export const OFFER_MAX_AHEAD_DAYS = 60  // how far ahead an offer may start

export interface MenuOffer {
  id: string
  restaurant_id: string
  menu_item_id: string | null
  kind: OfferKind
  offer_price: number | null
  starts_on: string
  ends_on: string
}

// The restaurant's zone: its own column, else its city's, else Douala.
export function restaurantZone(r: { timezone?: string | null; city?: string | null }): string {
  return r.timezone || timezoneForCity(r.city)
}

// 'YYYY-MM-DD' as the calendar reads in that zone.
export function dateInZone(tz: string, at: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at)
  } catch {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Douala', year: 'numeric', month: '2-digit', day: '2-digit' }).format(at)
  }
}

export function addDaysISO(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000)
}

export function isOfferLive(o: Pick<MenuOffer, 'starts_on' | 'ends_on'>, today: string): boolean {
  return o.starts_on <= today && today <= o.ends_on
}

// "−20 %" for a price offer badge.
export function percentOffLabel(regular: number, offer: number): string {
  if (!(regular > 0) || !(offer < regular)) return ''
  return `−${Math.round((1 - offer / regular) * 100)} %`
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export type OfferValidation =
  | { ok: true; offer: { kind: OfferKind; menu_item_id: string | null; offer_price: number | null; starts_on: string; ends_on: string } }
  | { ok: false; error: string }

// `regularPrice` is the dish's menu price (price offers only).
export function validateOffer(raw: {
  kind?: unknown; menu_item_id?: unknown; offer_price?: unknown; starts_on?: unknown; ends_on?: unknown
}, today: string, regularPrice?: number | null): OfferValidation {
  const kind = raw.kind === 'free_delivery' ? 'free_delivery' : raw.kind === 'price' ? 'price' : null
  if (!kind) return { ok: false, error: 'Type d\'offre invalide / Invalid offer type' }

  const starts = typeof raw.starts_on === 'string' && ISO_DATE.test(raw.starts_on) ? raw.starts_on : today
  const ends   = typeof raw.ends_on === 'string' && ISO_DATE.test(raw.ends_on) ? raw.ends_on : starts
  if (starts < today) return { ok: false, error: 'La date de début est passée / The start date has passed' }
  if (ends < starts)  return { ok: false, error: 'La date de fin est avant le début / The end date is before the start' }
  if (daysBetween(starts, ends) > OFFER_MAX_SPAN_DAYS) {
    return { ok: false, error: `${OFFER_MAX_SPAN_DAYS} jours au plus / ${OFFER_MAX_SPAN_DAYS} days at most` }
  }
  if (daysBetween(today, starts) > OFFER_MAX_AHEAD_DAYS) {
    return { ok: false, error: `Début dans ${OFFER_MAX_AHEAD_DAYS} jours au plus / Start within ${OFFER_MAX_AHEAD_DAYS} days` }
  }

  if (kind === 'free_delivery') {
    return { ok: true, offer: { kind, menu_item_id: null, offer_price: null, starts_on: starts, ends_on: ends } }
  }

  const itemId = typeof raw.menu_item_id === 'string' ? raw.menu_item_id : ''
  if (!itemId) return { ok: false, error: 'Choisissez un plat / Pick a dish' }
  const price = Number(raw.offer_price)
  if (!Number.isInteger(price) || price <= 0) {
    return { ok: false, error: 'Prix de l\'offre invalide / Invalid offer price' }
  }
  if (regularPrice != null && price >= regularPrice) {
    return { ok: false, error: 'Le prix de l\'offre doit être inférieur au prix normal / The offer price must be below the regular price' }
  }
  return { ok: true, offer: { kind, menu_item_id: itemId, offer_price: price, starts_on: starts, ends_on: ends } }
}
