// Server side of "À la une" (see lib/homeFeatured.ts).
//
// Works before supabase-home-featured.sql has run: reading the missing table
// returns an error, which reads as "no admin pick", so the card falls back to
// the city's events.

import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { EVENT_DATE_COLUMNS, isFinishedEvent, type EventWhen } from '@/lib/eventDate'
import { eventStartKey, hasPicture } from '@/lib/popularRanking'
import { takesOrders } from '@/lib/modules'
import { readOrdersPause } from '@/lib/ordersPauseServer'
import { getPlatformStatus, type PlatformStatus } from '@/lib/platformSwitch'
import { todayInDouala } from '@/lib/weekend'
import { featuredHref, type FeaturedCard, type FeaturedSource, type FeaturedType } from '@/lib/homeFeatured'

const EVENT_COLS = `id, title, city, venue, cover_photo, photo_credit, is_active, is_featured, event_status, booking_mode, reservations_open, ${EVENT_DATE_COLUMNS}`
const RESTAURANT_COLS = 'id, name, city, neighborhood, image_url, logo_url, photo_credit, is_active, status, deleted_at, modules'
const PLACE_COLS = 'id, title_fr, title_en, city, area, cover_url, photo_credit, status'

type EventRow = EventWhen & {
  id: string; title: string; city: string; venue: string | null; cover_photo: string | null; photo_credit?: string | null
  is_active: boolean; is_featured: boolean | null; event_status: string | null; booking_mode: string | null; reservations_open: boolean | null
}
type RestaurantRow = {
  id: string; name: string; city: string; neighborhood: string | null; image_url: string | null; logo_url: string | null; photo_credit?: string | null
  is_active: boolean; status: string; deleted_at: string | null; modules: string[] | null
}
type PlaceRow = {
  id: string; title_fr: string; title_en: string | null; city: string; area: string | null
  cover_url: string | null; photo_credit: string | null; status: string
}

const photo = (url: string | null | undefined) => (hasPicture(url) ? String(url).trim() : null)

/** Live = active, approved, not cancelled and not over (in Douala time). */
function eventLive(e: EventRow, today: string): boolean {
  return e.is_active === true
    && !['cancelled', 'rejected', 'pending'].includes(String(e.event_status ?? ''))
    && !isFinishedEvent(e, today)
}

function eventCard(e: EventRow, source: FeaturedSource): FeaturedCard {
  const bookable = e.booking_mode !== 'info' && e.reservations_open !== false
  return {
    type: 'event', id: e.id, title_fr: e.title, title_en: null,
    image: photo(e.cover_photo), credit: photo(e.cover_photo) ? e.photo_credit ?? null : null, href: featuredHref('event', e.id),
    action: bookable ? 'book' : 'view',
    when: { date: e.date, end_date: e.end_date, time: e.time ?? null, end_time: e.end_time ?? null },
    area: e.venue, source,
  }
}

/** The card for one item, or null when it isn't live (or its side is off). */
export async function resolveFeaturedItem(
  type: FeaturedType, id: string, opts: { today?: string; platform?: PlatformStatus } = {},
): Promise<FeaturedCard | null> {
  const today = opts.today ?? todayInDouala()
  const platform = opts.platform ?? await getPlatformStatus()
  if (type === 'event') {
    if (!platform.events) return null
    const { data } = await supabaseAdmin.from('events').select(EVENT_COLS).eq('id', id).maybeSingle()
    const e = data as unknown as EventRow | null
    return e && eventLive(e, today) ? eventCard(e, 'pick') : null
  }
  if (type === 'restaurant') {
    if (!platform.restaurants) return null
    const { data } = await supabaseAdmin.from('restaurants').select(RESTAURANT_COLS).eq('id', id).maybeSingle()
    const r = data as unknown as RestaurantRow | null
    if (!r || !r.is_active || !['active', 'approved'].includes(r.status) || r.deleted_at) return null
    const paused = takesOrders(r) ? (await readOrdersPause(r.id)).paused : false
    return {
      type: 'restaurant', id: r.id, title_fr: r.name, title_en: null,
      image: photo(r.image_url) ?? photo(r.logo_url), credit: (photo(r.image_url) ?? photo(r.logo_url)) ? r.photo_credit ?? null : null, href: featuredHref('restaurant', r.id),
      action: takesOrders(r) && !paused ? 'order' : 'view', when: null, area: r.neighborhood, source: 'pick',
    }
  }
  const { data } = await supabaseAdmin.from('places').select(PLACE_COLS).eq('id', id).maybeSingle()
  const p = data as unknown as PlaceRow | null
  if (!p || p.status !== 'active') return null
  return {
    type: 'place', id: p.id, title_fr: p.title_fr, title_en: p.title_en,
    image: photo(p.cover_url), credit: p.photo_credit, href: featuredHref('place', p.id),
    action: 'view', when: null, area: p.area, source: 'pick',
  }
}

/** The city of an item (admin pick check), or null when it doesn't exist. */
export async function featuredItemCity(type: FeaturedType, id: string): Promise<string | null> {
  const table = type === 'event' ? 'events' : type === 'restaurant' ? 'restaurants' : 'places'
  const { data } = await supabaseAdmin.from(table).select('city').eq('id', id).maybeSingle()
  return (data as { city?: string } | null)?.city ?? null
}

export interface FeaturedPickRow {
  id: string; city: string; item_type: FeaturedType; item_id: string
  starts_on: string; ends_on: string; created_at: string
}

/** The admin picks running today in the city, newest first. null = table missing. */
async function runningPicks(city: string, today: string): Promise<FeaturedPickRow[] | null> {
  const { data, error } = await supabaseAdmin.from('home_featured')
    .select('id, city, item_type, item_id, starts_on, ends_on, created_at')
    .eq('city', city).is('deleted_at', null).lte('starts_on', today).gte('ends_on', today)
    .order('created_at', { ascending: false })
  if (error) return null
  return (data ?? []) as FeaturedPickRow[]
}

/**
 * The city's "À la une" card: the newest running admin pick that is still
 * live; else the next is_featured event with a real photo; else the next
 * event with a real photo; else null (no card).
 */
export async function homeFeaturedCard(city: string, now: Date = new Date()): Promise<FeaturedCard | null> {
  const today = todayInDouala(now)
  const platform = await getPlatformStatus()
  for (const p of (await runningPicks(city, today)) ?? []) {
    const card = await resolveFeaturedItem(p.item_type, p.item_id, { today, platform })
    if (card) return card
  }
  if (!platform.events) return null
  const { data } = await supabaseAdmin.from('events').select(EVENT_COLS).eq('city', city).eq('is_active', true)
  const live = ((data ?? []) as unknown as EventRow[])
    .filter(e => eventLive(e, today) && hasPicture(e.cover_photo))
    .sort((a, b) => eventStartKey(a, today).localeCompare(eventStartKey(b, today)))
  const featured = live.find(e => e.is_featured === true)
  if (featured) return eventCard(featured, 'featured_event')
  return live[0] ? eventCard(live[0], 'next_event') : null
}
