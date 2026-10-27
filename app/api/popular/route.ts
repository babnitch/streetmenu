import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { RESTAURANT_CITIES } from '@/lib/restaurantSignup'
import { EVENT_DATE_COLUMNS, isPastEvent } from '@/lib/eventDate'

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
export async function GET(req: NextRequest) {
  const city = req.nextUrl.searchParams.get('city') ?? ''
  if (!RESTAURANT_CITIES.some(c => c.name === city)) {
    return NextResponse.json({ error: 'city' }, { status: 400 })
  }
  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString()

  const [restRes, evRes] = await Promise.all([
    supabaseAdmin.from('restaurants')
      .select('id, name, cuisine_type, neighborhood, image_url, logo_url')
      .eq('city', city).eq('is_active', true).in('status', ['active', 'approved']).is('deleted_at', null),
    supabaseAdmin.from('events')
      .select(`id, title, category, venue, cover_photo, ${EVENT_DATE_COLUMNS}`)
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

  return NextResponse.json({
    restaurants: restaurants.filter(r => (orders[r.id] ?? 0) > 0)
      .sort((a, b) => (orders[b.id] ?? 0) - (orders[a.id] ?? 0)).slice(0, LIMIT),
    events: events.filter(e => (seats[e.id] ?? 0) > 0)
      .sort((a, b) => (seats[b.id] ?? 0) - (seats[a.id] ?? 0)).slice(0, LIMIT),
  }, { headers: { 'Cache-Control': 'no-store' } })
}
