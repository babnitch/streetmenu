import { NextRequest, NextResponse } from 'next/server'
import { getEventAvailability } from '@/lib/eventSeats'
import { todayISO } from '@/lib/eventDate'

export const dynamic = 'force-dynamic'

// GET /api/events/[id]/availability
// Seats per day and per tier, computed from the reservations that hold seats
// (supabase-event-day-capacity.sql → event_availability). Public: it is the
// same information the booking page shows. remaining null = unlimited.
//
// { days: [{ date, past, capacity, sold, remaining, soldOut,
//            tiers: [{ tier_id, capacity, sold, remaining, soldOut }] }] }
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const days = await getEventAvailability(params.id, todayISO())
  if (!days) {
    return NextResponse.json({ error: 'Disponibilité indisponible / Availability unavailable' }, { status: 500 })
  }
  return NextResponse.json({ days })
}
