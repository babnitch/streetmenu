import { NextRequest, NextResponse } from 'next/server'
import { getEventAvailability } from '@/lib/eventSeats'
import { todayISO } from '@/lib/eventDate'

export const dynamic = 'force-dynamic'

// GET /api/events/availability?q=<eventId>:<YYYY-MM-DD>,…
// The Events list's per-card status for the day each card is shown for.
// Public, like /api/events/[id]/availability (same data, fewer requests).
//
// { status: { [eventId]: { date, soldOut, otherDaysAvailable } } }
//   soldOut            — no seat left that day (event cap, or every tier full)
//   otherDaysAvailable — another future day of the event still has room
const MAX_PAIRS = 60
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DAY = /^\d{4}-\d{2}-\d{2}$/

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get('q') ?? ''
  const pairs = raw.split(',').map(p => p.split(':')).filter(([id, day]) => UUID.test(id ?? '') && DAY.test(day ?? ''))
  if (pairs.length === 0) return NextResponse.json({ status: {} })
  if (pairs.length > MAX_PAIRS) {
    return NextResponse.json({ error: `max ${MAX_PAIRS} events` }, { status: 400 })
  }

  const today = todayISO()
  const status: Record<string, { date: string; soldOut: boolean; otherDaysAvailable: boolean }> = {}
  await Promise.all(pairs.map(async ([id, day]) => {
    const days = await getEventAvailability(id, today)
    if (!days) return                                  // unknown → the card shows no badge
    const d = days.find(x => x.date === day)
    status[id] = {
      date: day,
      soldOut: !!d?.soldOut,
      otherDaysAvailable: days.some(x => !x.past && x.date !== day && !x.soldOut),
    }
  }))
  return NextResponse.json({ status })
}
