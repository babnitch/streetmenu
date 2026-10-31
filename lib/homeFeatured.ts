// "À la une": ONE big card per city at the top of the home page.
//
// Admin → À la une picks an event, a restaurant or a place for a city and a
// date range (home_featured, supabase-home-featured.sql). Without a live pick
// the card falls back to the city's next "is_featured" event with a real
// photo, else its next event with a real photo, else no card. Never a
// generated cover. Only active items; an ended event drops out by itself.
//
// Client-safe: types, labels and the admin input check. The server side is
// lib/homeFeaturedServer.ts.

import type { EventWhen } from '@/lib/eventDate'

export const FEATURED_TYPES = ['event', 'restaurant', 'place'] as const
export type FeaturedType = typeof FEATURED_TYPES[number]

/** What the card's one button does. */
export type FeaturedAction = 'book' | 'order' | 'view'

/** Where the card came from: an admin pick, or a fallback. */
export type FeaturedSource = 'pick' | 'featured_event' | 'next_event'

export interface FeaturedCard {
  type: FeaturedType
  id: string
  title_fr: string
  title_en: string | null
  /** A real photo URL, or null (the card then shows no image). */
  image: string | null
  /** Photo credit (places from Wikimedia Commons). */
  credit: string | null
  href: string
  action: FeaturedAction
  /** Events: the dates, for formatEventWhen. */
  when: EventWhen | null
  /** Restaurants and places: the area; events: the venue. */
  area: string | null
  source: FeaturedSource
}

type Lang = 'fr' | 'en'

export function featuredTitle(c: Pick<FeaturedCard, 'title_fr' | 'title_en'>, lang: Lang): string {
  return (lang === 'en' ? c.title_en || c.title_fr : c.title_fr || c.title_en) ?? ''
}

export function featuredActionLabel(a: FeaturedAction, lang: Lang): string {
  if (a === 'book') return lang === 'en' ? 'Book' : 'Réserver'
  if (a === 'order') return lang === 'en' ? 'Order' : 'Commander'
  return lang === 'en' ? 'View' : 'Voir'
}

export function featuredTypeLabel(t: FeaturedType, lang: Lang): string {
  if (t === 'event') return lang === 'en' ? 'Event' : 'Événement'
  if (t === 'restaurant') return 'Restaurant'
  return lang === 'en' ? 'Place' : 'Lieu'
}

export function featuredHref(t: FeaturedType, id: string): string {
  return t === 'event' ? `/events/${id}` : t === 'restaurant' ? `/restaurant/${id}` : `/lieux/${id}`
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface FeaturedInput { city: string; item_type: FeaturedType; item_id: string; starts_on: string; ends_on: string }

/** Admin form check. `today` (YYYY-MM-DD): a range can't end in the past. */
export function validateFeaturedInput(body: unknown, today: string):
  { ok: true; value: FeaturedInput } | { ok: false; error: string } {
  const b = (body ?? {}) as Record<string, unknown>
  const city = typeof b.city === 'string' ? b.city.trim() : ''
  if (!city) return { ok: false, error: 'Ville manquante / City missing' }
  if (!FEATURED_TYPES.includes(b.item_type as FeaturedType)) return { ok: false, error: 'Type invalide / Invalid type' }
  if (typeof b.item_id !== 'string' || !UUID.test(b.item_id)) return { ok: false, error: 'Élément manquant / Item missing' }
  const starts = typeof b.starts_on === 'string' ? b.starts_on : ''
  const ends = typeof b.ends_on === 'string' ? b.ends_on : ''
  if (!ISO_DATE.test(starts) || !ISO_DATE.test(ends)) return { ok: false, error: 'Dates invalides / Invalid dates' }
  if (ends < starts) return { ok: false, error: 'La fin est avant le début / The end is before the start' }
  if (ends < today) return { ok: false, error: 'La fin est déjà passée / The end is already past' }
  return { ok: true, value: { city, item_type: b.item_type as FeaturedType, item_id: b.item_id, starts_on: starts, ends_on: ends } }
}
