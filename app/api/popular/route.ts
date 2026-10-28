import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { RESTAURANT_CITIES } from '@/lib/restaurantSignup'
import { EVENT_DATE_COLUMNS, isPastEvent } from '@/lib/eventDate'
import { loadTodayOffers } from '@/lib/offersServer'
import { getPlatformStatus } from '@/lib/platformSwitch'
import { deliversNow } from '@/lib/modules'

export const dynamic = 'force-dynamic'

const WINDOW_DAYS = 30
const LIMIT = 6

// GET /api/popular?city=Yaoundé — the home page's "Populaires à [ville]".
//   restaurants: live restaurants of the city with the most orders in the last
//                30 days (at least one), most first;
//   events:      the city's upcoming events with the most bookings (seats
//                held) in the last 30 days, most first.
// Public: only public fields and counts' ORDER (never the counts or who
// ordered). Empty lists → the home page hides the section.
//
// V3: restaurants carry what the card shows — delivery on/off, fee (0 on a
// free-delivery day, free_delivery true), prep and ride minutes; events carry
// price_from (lowest active tier, else ticket_price) and is_free.
export async function GET(req: NextRequest) {
  const city = req.nextUrl.searchParams.get('city') ?? ''
  if (!RESTAURANT_CITIES.some(c => c.name === city)) {
    return NextResponse.json({ error: 'city' }, { status: 400 })
  }
  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString()

  const [restRes, evRes] = await Promise.all([
    supabaseAdmin.from('restaurants')
      .select('id, name, cuisine_type, neighborhood, image_url, logo_url, prep_time_min, prep_time_max, delivery_enabled, delivery_fee, delivery_extra_min, modules')
      .eq('city', city).eq('is_active', true).in('status', ['active', 'approved']).is('deleted_at', null),
    supabaseAdmin.from('events')
      .select(`id, title, category, venue, cover_photo, ticket_price, ${EVENT_DATE_COLUMNS}`)
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

  const topRestaurants = restaurants.filter(r => (orders[r.id] ?? 0) > 0)
    .sort((a, b) => (orders[b.id] ?? 0) - (orders[a.id] ?? 0)).slice(0, LIMIT)
  const topEvents = events.filter(e => (seats[e.id] ?? 0) > 0)
    .sort((a, b) => (seats[b.id] ?? 0) - (seats[a.id] ?? 0)).slice(0, LIMIT)

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
    restaurants: !platform.restaurants ? [] : topRestaurants.map(r => {
      // M2: delivery only with the Livraison module; modules stay server-side.
      const { modules: _m, ...pub } = r
      void _m
      const delivers = deliversNow(r)
      const free = offers[r.id]?.freeDelivery === true && delivers
      return { ...pub, delivery_enabled: delivers, delivery_fee: free ? 0 : r.delivery_fee, free_delivery: free }
    }),
    events: !platform.events ? [] : topEvents.map(e => {
      const prices = tierPrices[e.id]
      const own = Math.max(0, Math.round(Number((e as { ticket_price?: number | null }).ticket_price ?? 0)))
      const paid = (prices ?? [own]).filter(p => p > 0)
      return { ...e, price_from: paid.length ? Math.min(...paid) : 0, is_free: paid.length === 0, has_tiers: !!prices && new Set(prices).size > 1 }
    }),
  }, { headers: { 'Cache-Control': 'no-store' } })
}
