import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { isRestaurantOpen, timezoneForCity } from '@/lib/openingHours'

export const dynamic = 'force-dynamic'

// GET /api/restaurants/open-status?ids=a,b,c
// Bulk computed status for the home-page card list. Two queries: one
// for the restaurants (with city + timezone + override), one for all
// their schedule rows. The status is computed server-side so the
// browser never has to know how to interpret timezones — cards just
// read { id → { open, next_at, next_kind } }.
//
// Cached for 1 minute via the Cache-Control header. Restaurant open/
// closed state changes at most every few minutes (at the natural schedule
// boundaries) so a fresh-every-load fetch is wasted bandwidth.
export async function GET(req: NextRequest) {
  const idsParam = req.nextUrl.searchParams.get('ids') ?? ''
  const ids = idsParam.split(',').map(s => s.trim()).filter(Boolean).slice(0, 200)
  if (ids.length === 0) return NextResponse.json({ status: {} })

  const [{ data: rests }, { data: hours }] = await Promise.all([
    supabaseAdmin.from('restaurants').select('id, city, timezone, manual_override').in('id', ids),
    supabaseAdmin.from('restaurant_hours').select('restaurant_id, day_of_week, open_time, close_time, is_closed').in('restaurant_id', ids),
  ])

  // Group hours by restaurant_id once so the per-restaurant call doesn't
  // re-scan the whole list.
  const hoursBy = new Map<string, Array<{ day_of_week: number; open_time: string; close_time: string; is_closed: boolean }>>()
  for (const h of hours ?? []) {
    const arr = hoursBy.get(h.restaurant_id) ?? []
    arr.push(h)
    hoursBy.set(h.restaurant_id, arr)
  }

  const status: Record<string, { open: boolean; source: string; next_kind?: string; next_at?: string; next_day?: number }> = {}
  for (const r of rests ?? []) {
    const tz = r.timezone || timezoneForCity(r.city)
    const result = isRestaurantOpen({
      manual_override: r.manual_override as 'open' | 'closed' | null,
      timezone:        tz,
      hours:           hoursBy.get(r.id) ?? [],
    })
    status[r.id] = {
      open:      result.open,
      source:    result.source,
      next_kind: result.next_transition?.kind,
      next_at:   result.next_transition?.at,
      next_day:  result.next_transition?.day,
    }
  }

  return new NextResponse(JSON.stringify({ status }), {
    status: 200,
    headers: {
      'Content-Type':  'application/json',
      // 60s edge cache + SWR keeps the home feed snappy without serving
      // stale state on a schedule transition for more than a minute.
      'Cache-Control': 'public, max-age=0, s-maxage=60, stale-while-revalidate=120',
    },
  })
}
