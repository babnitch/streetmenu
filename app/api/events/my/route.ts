import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'

export const dynamic = 'force-dynamic'

// GET /api/events/my
// Returns events organized by the logged-in customer (organizer_id match).
// Each row carries a small slice + the aggregate reservations_count and
// revenue (sum of total_price of paid reservations) so the /account
// "Mes événements" tab can render without N follow-up queries.
//
// Admins get every event with the same aggregates — they manage everyone.
export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req)
  if (!session) return NextResponse.json({ events: [] })

  const isAdmin = ['super_admin', 'admin', 'moderator'].includes(session.role)

  // Base query: own events for customers, all events for admins. Limit to
  // 50 most-recent — organizers rarely run more, admins paginate later.
  let query = supabaseAdmin
    .from('events')
    .select('id, title, date, time, venue, city, cover_photo, ticket_price, max_tickets, tickets_sold, payment_enabled, organizer_id, organizer_name, event_status, is_active, created_at')
    .order('date', { ascending: false })
    .limit(50)
  if (!isAdmin) {
    if (session.role !== 'customer') return NextResponse.json({ events: [] })
    query = query.eq('organizer_id', session.id)
  }
  const { data: events, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  if (!events || events.length === 0) return NextResponse.json({ events: [] })

  // Aggregate reservations per event. Single query, group client-side.
  const ids = events.map(e => e.id)
  const { data: resv } = await supabaseAdmin
    .from('event_reservations')
    .select('event_id, payment_status, reservation_status, total_price, quantity')
    .in('event_id', ids)

  const aggBy = new Map<string, { reservations_count: number; tickets_count: number; revenue: number; pending_count: number }>()
  for (const r of resv ?? []) {
    const agg = aggBy.get(r.event_id) ?? { reservations_count: 0, tickets_count: 0, revenue: 0, pending_count: 0 }
    if (r.reservation_status !== 'cancelled') {
      agg.reservations_count += 1
      agg.tickets_count      += Number(r.quantity ?? 0)
    }
    if (r.payment_status === 'paid')    agg.revenue       += Number(r.total_price ?? 0)
    if (r.payment_status === 'pending') agg.pending_count += 1
    aggBy.set(r.event_id, agg)
  }

  const enriched = events.map(e => ({
    ...e,
    reservations_count: aggBy.get(e.id)?.reservations_count ?? 0,
    tickets_count:      aggBy.get(e.id)?.tickets_count      ?? 0,
    revenue:            aggBy.get(e.id)?.revenue            ?? 0,
    pending_count:      aggBy.get(e.id)?.pending_count      ?? 0,
  }))

  return NextResponse.json({ events: enriched, isAdmin })
}
