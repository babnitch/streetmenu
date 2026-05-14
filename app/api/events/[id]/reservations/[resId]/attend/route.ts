import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'

export const dynamic = 'force-dynamic'

// POST /api/events/[id]/reservations/[resId]/attend
// Organizer (organizer_id match) or admin marks a confirmed reservation as
// 'attended'. No customer ping — the customer is physically at the event.
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string; resId: string } },
) {
  const session = getSessionFromRequest(req)
  if (!session) return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })

  const isAdmin = ['super_admin', 'admin', 'moderator'].includes(session.role)

  const { data: event } = await supabaseAdmin
    .from('events').select('id, organizer_id').eq('id', params.id).maybeSingle()
  if (!event) return NextResponse.json({ error: 'Événement introuvable / Event not found' }, { status: 404 })

  if (!isAdmin && event.organizer_id !== session.id) {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 403 })
  }

  const { data: r } = await supabaseAdmin
    .from('event_reservations')
    .select('id, reservation_status, quantity')
    .eq('id', params.resId).eq('event_id', params.id).maybeSingle()
  if (!r) return NextResponse.json({ error: 'Réservation introuvable / Reservation not found' }, { status: 404 })

  if (r.reservation_status === 'cancelled') {
    return NextResponse.json({ error: 'Réservation annulée / Reservation cancelled' }, { status: 409 })
  }

  await supabaseAdmin
    .from('event_reservations')
    .update({ reservation_status: 'attended', updated_at: new Date().toISOString() })
    .eq('id', r.id)

  await writeAudit({
    action:          'event_reservation_attended',
    targetType:      'event_reservation',
    targetId:        r.id,
    performedBy:     session.id,
    performedByType: isAdmin ? session.role : 'organizer',
    previousData:    { reservation_status: r.reservation_status },
    metadata:        { event_id: event.id, quantity: r.quantity },
  })

  return NextResponse.json({ ok: true })
}
