import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { isEventOrganizer } from '@/lib/eventAuth'
import { generateReservationCodes } from '@/lib/reservationCode'

export const dynamic = 'force-dynamic'

// GET /api/events/[id]/reservations
// Organizer (event.organizer_id === session.id) or admin only. Returns
// every reservation for the event with customer name + phone + status —
// the data the organizer view in /account renders.
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionFromRequest(req)
  if (!session) return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })

  const isAdmin = ['super_admin', 'admin', 'moderator'].includes(session.role)

  const { data: event } = await supabaseAdmin
    .from('events').select('id, organizer_id, submitted_by').eq('id', params.id).maybeSingle()
  if (!event) return NextResponse.json({ error: 'Événement introuvable / Event not found' }, { status: 404 })

  if (!isAdmin && !isEventOrganizer(event, session.id)) {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 403 })
  }

  const { data, error } = await supabaseAdmin
    .from('event_reservations')
    .select('id, customer_name, customer_phone, quantity, total_price, payment_status, payment_method, reservation_status, reservation_code, created_at')
    .eq('event_id', params.id)
    .order('created_at', { ascending: false })

  if (error) {
    console.error('[events/reservations] select failed:', error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Backfill: rows created before the reservation_code migration (or by a
  // path that predates it) have no code, so the organizer's list showed a
  // reservation with nothing to quote at the door. Mint one on first read and
  // persist it, so the code the organizer sees is the code the check-in
  // command ("present A3F7") resolves.
  const rows = data ?? []
  const missing = rows.filter(r => !r.reservation_code)
  if (missing.length > 0) {
    console.log('[events/reservations] backfilling %d reservation code(s) for event %s', missing.length, params.id)
    const codes = await generateReservationCodes(missing.length)
    await Promise.all(missing.map((r, i) =>
      supabaseAdmin
        .from('event_reservations')
        .update({ reservation_code: codes[i] })
        .eq('id', r.id)
        .then(({ error: upErr }) => {
          if (upErr) console.error('[events/reservations] backfill failed for %s: %s', r.id, upErr.message)
          else r.reservation_code = codes[i]
        }),
    ))
  }

  return NextResponse.json({ reservations: rows })
}
