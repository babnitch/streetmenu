import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'

export const dynamic = 'force-dynamic'

// GET /api/admin/events
// Admin/super_admin/moderator only. Returns EVERY event regardless of
// is_active — the admin console must see pending (is_active=false) events
// awaiting approval, which the public RLS policy (public_active_read:
// is_active = TRUE) hides from the browser's anon client.
//
// Aggregates (reservations/revenue/commission) and submitter trust are
// computed here too because event_reservations + customers are locked to
// service-role by supabase-rls-policies.sql — the client can't read them.
export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req)
  if (!session || !['super_admin', 'admin', 'moderator'].includes(session.role)) {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }

  const { data: events, error } = await supabaseAdmin
    .from('events')
    .select('*')
    .order('created_at', { ascending: false })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const list = events ?? []
  if (list.length === 0) {
    return NextResponse.json({ events: [], aggregates: {}, submitters: {} })
  }

  // Reservation aggregates — single query, grouped by event. Cancelled
  // reservations are excluded from the count; only 'paid' rows contribute
  // to revenue + platform commission.
  const ids = list.map(e => e.id)
  const { data: resv } = await supabaseAdmin
    .from('event_reservations')
    .select('event_id, payment_status, reservation_status, total_price, quantity, commission_amount')
    .in('event_id', ids)

  type Agg = { reservations_count: number; tickets_count: number; revenue: number; commission: number }
  const aggregates: Record<string, Agg> = {}
  for (const r of resv ?? []) {
    const a = aggregates[r.event_id] ?? { reservations_count: 0, tickets_count: 0, revenue: 0, commission: 0 }
    if (r.reservation_status !== 'cancelled') {
      a.reservations_count += 1
      a.tickets_count      += Number(r.quantity ?? 0)
    }
    if (r.payment_status === 'paid') {
      a.revenue    += Number(r.total_price ?? 0)
      a.commission += Number(r.commission_amount ?? 0)
    }
    aggregates[r.event_id] = a
  }

  // Submitter trust info — unique organizer_id set, single query.
  const submitters: Record<string, unknown> = {}
  const orgIds = Array.from(new Set(list.map(e => e.organizer_id).filter(Boolean) as string[]))
  if (orgIds.length > 0) {
    const { data: subs } = await supabaseAdmin
      .from('customers')
      .select('id, name, phone, events_approved_count, event_auto_approve')
      .in('id', orgIds)
    for (const s of subs ?? []) submitters[s.id] = s
  }

  return NextResponse.json({ events: list, aggregates, submitters })
}
