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
    .select('id, title, date, time, venue, city, cover_photo, ticket_price, max_tickets, tickets_sold, payment_enabled, payment_mode, whatsapp_payment_enabled, organizer_id, organizer_name, event_status, is_active, requires_confirmation, reservations_open, created_at')
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
  // commission_amount is stored per reservation by /reserve + /pay so a
  // mid-event rate change can't retroactively shift the organizer's payout.
  const ids = events.map(e => e.id)
  const { data: resv } = await supabaseAdmin
    .from('event_reservations')
    .select('event_id, payment_status, reservation_status, total_price, quantity, commission_amount')
    .in('event_id', ids)

  type Agg = { reservations_count: number; tickets_count: number; revenue: number; commission: number; pending_count: number; pending_approval_count: number }
  const aggBy = new Map<string, Agg>()
  for (const r of resv ?? []) {
    const agg: Agg = aggBy.get(r.event_id) ?? { reservations_count: 0, tickets_count: 0, revenue: 0, commission: 0, pending_count: 0, pending_approval_count: 0 }
    // Cancelled + rejected don't count toward tickets sold but they do
    // belong on the reservations list, so they're surfaced through the
    // reservations endpoint, not aggregated here.
    if (r.reservation_status !== 'cancelled' && r.reservation_status !== 'rejected') {
      agg.reservations_count += 1
      agg.tickets_count      += Number(r.quantity ?? 0)
    }
    if (r.payment_status === 'paid') {
      agg.revenue    += Number(r.total_price ?? 0)
      agg.commission += Number(r.commission_amount ?? 0)
    }
    if (r.payment_status === 'pending') agg.pending_count += 1
    if (r.reservation_status === 'pending') agg.pending_approval_count += 1
    aggBy.set(r.event_id, agg)
  }

  const enriched = events.map(e => {
    const a: Agg = aggBy.get(e.id) ?? { reservations_count: 0, tickets_count: 0, revenue: 0, commission: 0, pending_count: 0, pending_approval_count: 0 }
    return {
      ...e,
      reservations_count:      a.reservations_count,
      tickets_count:           a.tickets_count,
      revenue:                 a.revenue,
      commission:              a.commission,
      net_revenue:             Math.max(0, a.revenue - a.commission),
      pending_count:           a.pending_count,
      pending_approval_count:  a.pending_approval_count,
    }
  })

  // Surface the caller's publisher trust state alongside their events so
  // the /account "Mes événements" tab can render the verified badge in
  // one round-trip.
  let trust: { events_submitted_count: number; events_approved_count: number; event_auto_approve: boolean } | null = null
  if (!isAdmin) {
    const { data: c } = await supabaseAdmin
      .from('customers')
      .select('events_submitted_count, events_approved_count, event_auto_approve')
      .eq('id', session.id)
      .maybeSingle()
    if (c) trust = c
  }

  return NextResponse.json({ events: enriched, isAdmin, trust })
}
