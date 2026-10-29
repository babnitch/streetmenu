import { requireProMode } from '@/lib/proModeServer'
import { bookingIdOf } from '@/lib/scanLinks'
import { dateInZone, restaurantZone } from '@/lib/offers'
import { NextRequest, NextResponse } from 'next/server'
import { requireEventModule } from '@/lib/modulesServer'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { isEventOrganizer } from '@/lib/eventAuth'
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
  // Checking a guest in is a Pro action (Client mode refused).
  const notPro = await requireProMode(session)
  if (notPro) return notPro

  const { data: event } = await supabaseAdmin
    .from('events').select('id, organizer_id, submitted_by, city').eq('id', params.id).maybeSingle()
  if (!event) return NextResponse.json({ error: 'Événement introuvable / Event not found' }, { status: 404 })

  // M4: door check-in needs the Contrôle des billets module.
  const ctlOff = await requireEventModule(event, 'ticket_control')
  if (ctlOff) return ctlOff
  if (!isAdmin && !isEventOrganizer(event, session.id)) {
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

  // Q2: the same check-in record as a scan, so the ticket's QR then shows
  // "already used" today (no second entry). Booking-level; ignore a repeat.
  const bookingId = await bookingIdOf(r.id)
  await supabaseAdmin.from('event_checkins').upsert({
    reservation_id: bookingId, event_id: event.id,
    day: dateInZone(restaurantZone({ city: (event as { city?: string | null }).city ?? null })),
    people: r.quantity, checked_in_by: session.id, checked_in_by_type: isAdmin ? 'admin' : 'customer', via: 'code',
  }, { onConflict: 'reservation_id,day', ignoreDuplicates: true })

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
