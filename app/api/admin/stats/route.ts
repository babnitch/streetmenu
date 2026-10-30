import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { todayInDouala } from '@/lib/weekend'
import { isCity } from '@/lib/cities'
import { CLICK_METRICS } from '@/lib/stats'

export const dynamic = 'force-dynamic'

// GET /api/admin/stats?days=7|30|90&city=… — Admin → Statistiques (admin +
// super admin). From the anonymous daily counts: visits per day; top 10
// restaurants / events / places by views and by clicks, with orders or
// bookings over the same days (views → orders); top searches.
export async function GET(req: NextRequest) {
  const s = getSessionFromRequest(req)
  if (!s || !['super_admin', 'admin'].includes(s.role)) return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  const days = [7, 30, 90].includes(Number(req.nextUrl.searchParams.get('days'))) ? Number(req.nextUrl.searchParams.get('days')) : 30
  const cityParam = req.nextUrl.searchParams.get('city')
  const city = isCity(cityParam) ? cityParam : null
  const today = todayInDouala()
  const fromD = new Date(`${today}T00:00:00Z`); fromD.setUTCDate(fromD.getUTCDate() - (days - 1))
  const from = fromD.toISOString().slice(0, 10)
  const fromIso = new Date(Date.parse(`${from}T00:00:00Z`) - 3600_000).toISOString()

  let q = supabaseAdmin.from('stats_daily').select('day, city, item_type, item_id, metric, count').gte('day', from).range(0, 49999)
  if (city) q = q.eq('city', city)
  const { data, error } = await q
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  const rows = (data ?? []) as Array<{ day: string; item_type: string; item_id: string; metric: string; count: number }>

  // Visits per day (every day of the period, 0 when none).
  const visits: Record<string, number> = {}
  for (let d = new Date(fromD); d.toISOString().slice(0, 10) <= today; d.setUTCDate(d.getUTCDate() + 1)) visits[d.toISOString().slice(0, 10)] = 0
  const items: Record<string, Record<string, { views: number; clicks: number; byClick: Record<string, number> }>> = { restaurant: {}, event: {}, place: {} }
  const searches: Record<string, number> = {}
  for (const r of rows) {
    if (r.metric === 'visit') visits[r.day] = (visits[r.day] ?? 0) + r.count
    else if (r.metric === 'search') searches[r.item_id] = (searches[r.item_id] ?? 0) + r.count
    else if (items[r.item_type]) {
      const it = (items[r.item_type][r.item_id] ??= { views: 0, clicks: 0, byClick: {} })
      if (r.metric === 'view') it.views += r.count
      else if ((CLICK_METRICS as readonly string[]).includes(r.metric)) { it.clicks += r.count; it.byClick[r.metric] = (it.byClick[r.metric] ?? 0) + r.count }
    }
  }

  const NAME: Record<string, { table: string; col: string }> = { restaurant: { table: 'restaurants', col: 'name' }, event: { table: 'events', col: 'title' }, place: { table: 'places', col: 'title_fr' } }
  const tops: Record<string, unknown> = {}
  for (const type of ['restaurant', 'event', 'place'] as const) {
    const all = Object.entries(items[type]).map(([id, v]) => ({ id, ...v }))
    const ids = Array.from(new Set([...all].sort((a, b) => b.views - a.views).slice(0, 10).concat([...all].sort((a, b) => b.clicks - a.clicks).slice(0, 10)).map(x => x.id)))
    const names: Record<string, string> = {}
    const conv: Record<string, number> = {}
    if (ids.length) {
      const { data: n } = await supabaseAdmin.from(NAME[type].table).select(`id, ${NAME[type].col}`).in('id', ids)
      for (const x of (n ?? []) as unknown as Array<Record<string, string>>) names[x.id] = x[NAME[type].col]
      if (type === 'restaurant') {
        const { data: o } = await supabaseAdmin.from('orders').select('restaurant_id').in('restaurant_id', ids).gte('created_at', fromIso).neq('status', 'cancelled').range(0, 9999)
        for (const x of (o ?? []) as Array<{ restaurant_id: string }>) conv[x.restaurant_id] = (conv[x.restaurant_id] ?? 0) + 1
      } else if (type === 'event') {
        const { data: b } = await supabaseAdmin.from('event_reservations').select('event_id').in('event_id', ids).gte('created_at', fromIso).not('reservation_status', 'in', '(cancelled,rejected)').range(0, 9999)
        for (const x of (b ?? []) as Array<{ event_id: string }>) conv[x.event_id] = (conv[x.event_id] ?? 0) + 1
      }
    }
    const shape = (x: typeof all[number]) => ({ id: x.id, name: names[x.id] ?? '—', views: x.views, clicks: x.clicks, byClick: x.byClick, conversions: type === 'place' ? null : (conv[x.id] ?? 0) })
    tops[type] = {
      byViews: [...all].sort((a, b) => b.views - a.views).slice(0, 10).filter(x => x.views > 0).map(shape),
      byClicks: [...all].sort((a, b) => b.clicks - a.clicks).slice(0, 10).filter(x => x.clicks > 0).map(shape),
    }
  }
  return NextResponse.json({
    days, city, from, to: today,
    visits: Object.entries(visits).map(([day, count]) => ({ day, count })),
    totalVisits: Object.values(visits).reduce((a, b) => a + b, 0),
    tops,
    searches: Object.entries(searches).map(([words, count]) => ({ words, count })).sort((a, b) => b.count - a.count).slice(0, 20),
  }, { headers: { 'Cache-Control': 'no-store' } })
}
