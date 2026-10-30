import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { isServedCity } from '@/lib/cities'
import { EVENT_DATE_COLUMNS, isPastEvent } from '@/lib/eventDate'
import { loadTodayOffers } from '@/lib/offersServer'
import { getPlatformStatus } from '@/lib/platformSwitch'
import { deliversNow, hasModule } from '@/lib/modules'
import { todayInDouala } from '@/lib/weekend'
import { rankWithFill, eventStartKey } from '@/lib/popularRanking'

export const dynamic = 'force-dynamic'

const WINDOW_DAYS = 30
const LIMIT = 6

// GET /api/popular?city=Yaoundé — the home page's two rows (up to 6 each).
//   restaurants: live restaurants of the city with the most orders in the last
//                30 days, most first; filled up to 6 with the city's other
//                live restaurants — Mise en avant (featured module) first,
//                then the newest. restaurants_popular: at least one has orders.
//   events:      the city's upcoming approved events with the most bookings
//                (seats held) in the last 30 days, most first; filled up to 6
//                with the soonest upcoming ones. events_popular: at least one
//                has bookings. Never a past event.
// The home page titles the rows "populaires" only when something is, and
// hides a row only when the city has nothing at all.
// Public: only public fields and the ORDER (never the counts or who ordered).
//
// V3: restaurants carry what the card shows — delivery on/off, fee (0 on a
// free-delivery day, free_delivery true), prep and ride minutes; events carry
// price_from (lowest active tier, else ticket_price) and is_free.
export async function GET(req: NextRequest) {
  const city = req.nextUrl.searchParams.get('city') ?? ''
  if (!isServedCity(city)) {
    return NextResponse.json({ error: 'city' }, { status: 400 })
  }
  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString()

  const [restRes, evRes] = await Promise.all([
    supabaseAdmin.from('restaurants')
      .select('id, name, cuisine_type, neighborhood, image_url, logo_url, prep_time_min, prep_time_max, delivery_enabled, delivery_fee, delivery_extra_min, modules, created_at')
      .eq('city', city).eq('is_active', true).in('status', ['active', 'approved']).is('deleted_at', null),
    supabaseAdmin.from('events')
      .select(`id, title, category, venue, cover_photo, ticket_price, booking_mode, price_is_from, ${EVENT_DATE_COLUMNS}`)
      .eq('city', city).eq('is_active', true),
  ])
  const restaurants = restRes.data ?? []
  const events = ((evRes.data ?? []) as unknown as Array<{ id: string; [k: string]: unknown }>)
    .filter(e => !isPastEvent(e as never))

  const count = (rows: Array<Record<string, unknown>> | null, key: string, weight?: string) => {
    const m: Record<string, number> = {}
    for (const r of rows ?? []) {
      const k = r[key] as string
      m[k] = (m[k] ?? 0) + (weight ? Number(r[weight] ?? 1) : 1)
    }
    return m
  }

  const [ordRes, resvRes] = await Promise.all([
    restaurants.length
      ? supabaseAdmin.from('orders').select('restaurant_id')
          .in('restaurant_id', restaurants.map(r => r.id)).gte('created_at', since)
          .neq('status', 'cancelled').range(0, 9999)
      : Promise.resolve({ data: [] as Array<Record<string, unknown>> }),
    events.length
      ? supabaseAdmin.from('event_reservations').select('event_id, quantity')
          .in('event_id', events.map(e => e.id)).gte('created_at', since)
          .not('reservation_status', 'in', '(cancelled,rejected)').range(0, 9999)
      : Promise.resolve({ data: [] as Array<Record<string, unknown>> }),
  ])
  const orders = count(ordRes.data as Array<Record<string, unknown>> | null, 'restaurant_id')
  const seats  = count(resvRes.data as Array<Record<string, unknown>> | null, 'event_id', 'quantity')

  // Most popular first, then filled up to LIMIT (no duplicates):
  // restaurants Mise en avant first, then the newest; events the soonest.
  const today = todayInDouala()
  const restRank = rankWithFill(restaurants, r => orders[r.id] ?? 0, (a, b) =>
    Number(hasModule(b, 'featured')) - Number(hasModule(a, 'featured'))
    || String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')), LIMIT)
  const evRank = rankWithFill(events, e => seats[e.id] ?? 0, (a, b) =>
    eventStartKey(a as never, today).localeCompare(eventStartKey(b as never, today)), LIMIT)
  const topRestaurants = restRank.list
  const topEvents = evRank.list

  const [offers, tiersRes] = await Promise.all([
    loadTodayOffers(topRestaurants.map(r => r.id)),
    topEvents.length
      ? supabaseAdmin.from('event_ticket_tiers').select('event_id, price')
          .in('event_id', topEvents.map(e => e.id)).eq('is_active', true)
      : Promise.resolve({ data: [] as Array<{ event_id: string; price: number }> }),
  ])
  const tierPrices: Record<string, number[]> = {}
  for (const t of (tiersRes.data ?? []) as Array<{ event_id: string; price: number }>) {
    (tierPrices[t.event_id] ??= []).push(Math.round(Number(t.price)))
  }

  // M6: a side switched off shows nothing on the home page.
  const platform = await getPlatformStatus()
  return NextResponse.json({
    restaurants_popular: restRank.popular,
    events_popular: evRank.popular,
    restaurants: !platform.restaurants ? [] : topRestaurants.map(r => {
      // M2: delivery only with the Livraison module; modules stay server-side.
      const { modules: _m, created_at: _c, ...pub } = r
      void _m; void _c
      const delivers = deliversNow(r)
      const free = offers[r.id]?.freeDelivery === true && delivers
      return { ...pub, delivery_enabled: delivers, delivery_fee: free ? 0 : r.delivery_fee, free_delivery: free }
    }),
    events: !platform.events ? [] : topEvents.map(e => {
      const prices = tierPrices[e.id]
      const own = Math.max(0, Math.round(Number((e as { ticket_price?: number | null }).ticket_price ?? 0)))
      const paid = (prices ?? [own]).filter(p => p > 0)
      // I6: an info-only event with no price given shows no price.
      const { booking_mode: mode, ...pub } = e as typeof e & { booking_mode?: string | null }
      const unknown = mode === 'info' && !prices && (e as { ticket_price?: number | null }).ticket_price == null
      return { ...pub, price_from: paid.length ? Math.min(...paid) : 0, is_free: !unknown && paid.length === 0, has_tiers: !!prices && new Set(prices).size > 1, price_unknown: unknown }
    }),
  }, { headers: { 'Cache-Control': 'no-store' } })
}
