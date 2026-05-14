import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'

export const dynamic = 'force-dynamic'

// GET /api/customer/reservations
// Returns the logged-in customer's event reservations (most recent first),
// joined with a small slice of the event row so /account can render dates
// + venues without a second roundtrip.
//
// Returns 200 with an empty array for non-customers — the /account page
// uses this on every load and doesn't need to special-case unauthenticated
// users.
export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req)
  if (!session || session.role !== 'customer') {
    return NextResponse.json({ reservations: [] })
  }

  const { data, error } = await supabaseAdmin
    .from('event_reservations')
    .select('id, event_id, quantity, total_price, payment_status, reservation_status, created_at, events(id, title, date, time, venue, city, cover_photo, ticket_price, event_status)')
    .eq('customer_id', session.id)
    .order('created_at', { ascending: false })
    .limit(50)

  if (error) {
    console.error('[customer/reservations] list failed:', error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ reservations: data ?? [] })
}
