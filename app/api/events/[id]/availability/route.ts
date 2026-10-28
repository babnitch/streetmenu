import { NextRequest, NextResponse } from 'next/server'
import { getEventAvailability } from '@/lib/eventSeats'
import { todayISO } from '@/lib/eventDate'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { eventAllows } from '@/lib/modulesServer'

export const dynamic = 'force-dynamic'

// GET /api/events/[id]/availability
// Seats per day and per tier, computed from the reservations that hold seats
// (supabase-event-day-capacity.sql → event_availability). Public: it is the
// same information the booking page shows. remaining null = unlimited.
//
// { days: [{ date, past, capacity, sold, remaining, soldOut,
//            tiers: [{ tier_id, capacity, sold, remaining, soldOut }] }],
//   booking: { reservations, paid_tickets } }   — the organiser's modules (M4):
//   no Réservations → no booking button, contact the organiser instead.
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const days = await getEventAvailability(params.id, todayISO())
  if (!days) {
    return NextResponse.json({ error: 'Disponibilité indisponible / Availability unavailable' }, { status: 500 })
  }
  const { data: ev } = await supabaseAdmin.from('events').select('organizer_id').eq('id', params.id).maybeSingle()
  const booking = ev
    ? { reservations: await eventAllows(ev, 'reservations'), paid_tickets: await eventAllows(ev, 'paid_tickets') }
    : null
  return NextResponse.json({ days, booking })
}
