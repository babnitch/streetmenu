import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { isPastEvent } from '@/lib/eventDate'

export const dynamic = 'force-dynamic'

// GET /api/scan/my-events (Q4) — the upcoming / ongoing events the
// logged-in person checks tickets for: as door staff, or as organiser.
// Drives the ☰ "Contrôler des billets" entry and /scanner's list.
export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req)
  if (!session || session.role !== 'customer') return NextResponse.json({ events: [] })
  const { data: staff } = await supabaseAdmin.from('event_door_staff').select('event_id')
    .eq('customer_id', session.id).eq('status', 'active')
  const ids = ((staff ?? []) as Array<{ event_id: string }>).map(r => r.event_id)
  const cols = 'id, title, venue, date, end_date, time, end_time, is_active, event_status'
  const [{ data: asStaff }, { data: own }] = await Promise.all([
    ids.length ? supabaseAdmin.from('events').select(cols).in('id', ids) : Promise.resolve({ data: [] }),
    supabaseAdmin.from('events').select(cols).eq('organizer_id', session.id).eq('is_active', true),
  ])
  const seen = new Set<string>()
  type Row = { id: string; title: string; venue: string | null; date: string; end_date: string | null; time: string | null; end_time: string | null; event_status: string | null }
  const events = [...((asStaff ?? []) as Row[]).map(e => ({ ...e, role: 'door' as const })),
    ...((own ?? []) as Row[]).map(e => ({ ...e, role: 'organizer' as const }))]
    .filter(e => {
      if (seen.has(e.id)) return false
      seen.add(e.id)
      return e.event_status !== 'cancelled' && e.event_status !== 'rejected' && !isPastEvent(e as never)
    })
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .map(e => ({ id: e.id, title: e.title, venue: e.venue, date: e.date, end_date: e.end_date, role: e.role }))
  return NextResponse.json({ events }, { headers: { 'Cache-Control': 'no-store' } })
}
