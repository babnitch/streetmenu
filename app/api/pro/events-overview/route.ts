import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { todayInDouala } from '@/lib/weekend'
import { EVENT_DATE_COLUMNS, isPastEvent } from '@/lib/eventDate'
import { getEventAvailability } from '@/lib/eventSeats'

export const dynamic = 'force-dynamic'

// GET /api/pro/events-overview — the organiser's overview above "Mes
// événements": upcoming events with bookings, tickets, check-ins, revenue,
// commission, net, fill rate (per event and per day), page views. Totals
// over those events. The logged-in organiser's own events only.
export async function GET(req: NextRequest) {
  const s = getSessionFromRequest(req)
  if (!s || s.role !== 'customer') return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  const today = todayInDouala()
  const { data: evs } = await supabaseAdmin.from('events')
    .select(`id, title, city, ${EVENT_DATE_COLUMNS}, max_tickets, is_active, event_status`)
    .or(`organizer_id.eq.${s.id},submitted_by.eq.${s.id}`).neq('event_status', 'cancelled').limit(200)
  const upcoming = ((evs ?? []) as unknown as Array<{ id: string; title: string; city: string; date: string; end_date: string | null; max_tickets: number | null; is_active: boolean }>)
    .filter(e => !isPastEvent(e as never))
    .sort((a, b) => a.date.localeCompare(b.date))
  const ids = upcoming.map(e => e.id)
  if (!ids.length) return NextResponse.json({ events: [], totals: { events: 0, bookings: 0, tickets: 0, checkins: 0, revenue: 0, commission: 0, net: 0, views: 0 } })

  const [resv, checks, stats] = await Promise.all([
    supabaseAdmin.from('event_reservations').select('event_id, quantity, total_price, payment_status, refunded_amount, commission_amount, reservation_status')
      .in('event_id', ids).not('reservation_status', 'in', '(cancelled,rejected)').range(0, 9999),
    supabaseAdmin.from('event_checkins').select('event_id, people').in('event_id', ids).range(0, 9999),
    supabaseAdmin.from('stats_daily').select('item_id, metric, count').eq('item_type', 'event').in('item_id', ids).eq('metric', 'view'),
  ])
  const by = <T,>(rows: T[] | null, key: (r: T) => string) => {
    const m = new Map<string, T[]>(); for (const r of rows ?? []) { const k = key(r); m.set(k, [...(m.get(k) ?? []), r]) } return m
  }
  type R = { event_id: string; quantity: number; total_price: number; payment_status: string; refunded_amount: number | null; commission_amount: number | null }
  const resvBy = by((resv.data ?? []) as R[], r => r.event_id)
  const checkBy = by((checks.data ?? []) as Array<{ event_id: string; people: number }>, r => r.event_id)
  const viewsBy = by((stats.data ?? []) as Array<{ item_id: string; count: number }>, r => r.item_id)

  const events = await Promise.all(upcoming.map(async e => {
    const rows = resvBy.get(e.id) ?? []
    const paid = rows.filter(r => r.payment_status === 'paid')
    const revenue = paid.reduce((a, r) => a + Math.max(0, Math.round(Number(r.total_price)) - Number(r.refunded_amount ?? 0)), 0)
    const commission = paid.reduce((a, r) => a + Number(r.commission_amount ?? 0), 0)
    const av = (await getEventAvailability(e.id, today)) ?? []
    const days = av.filter(d => !d.past).map(d => ({ date: d.date, sold: d.sold, capacity: d.capacity, fill: d.capacity > 0 ? Math.round(100 * d.sold / d.capacity) : null }))
    const cap = days.reduce((a, d) => a + d.capacity, 0), sold = days.reduce((a, d) => a + d.sold, 0)
    return {
      id: e.id, title: e.title, date: e.date, end_date: e.end_date, is_active: e.is_active,
      bookings: rows.length, tickets: rows.reduce((a, r) => a + Number(r.quantity ?? 0), 0),
      checkins: (checkBy.get(e.id) ?? []).reduce((a, c) => a + Number(c.people ?? 1), 0),
      revenue, commission, net: revenue - commission,
      fill: cap > 0 ? Math.round(100 * sold / cap) : null, days,
      views: (viewsBy.get(e.id) ?? []).reduce((a, v) => a + v.count, 0),
    }
  }))
  const sum = (k: 'bookings' | 'tickets' | 'checkins' | 'revenue' | 'commission' | 'net' | 'views') => events.reduce((a, e) => a + e[k], 0)
  return NextResponse.json({
    events,
    totals: { events: events.length, bookings: sum('bookings'), tickets: sum('tickets'), checkins: sum('checkins'), revenue: sum('revenue'), commission: sum('commission'), net: sum('net'), views: sum('views') },
  }, { headers: { 'Cache-Control': 'no-store' } })
}
