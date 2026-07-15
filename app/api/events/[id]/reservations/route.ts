import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'

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
    .from('events').select('id, organizer_id').eq('id', params.id).maybeSingle()
  if (!event) return NextResponse.json({ error: 'Événement introuvable / Event not found' }, { status: 404 })

  if (!isAdmin && event.organizer_id !== session.id) {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 403 })
  }

  const { data, error } = await supabaseAdmin
    .from('event_reservations')
    .select('id, customer_name, customer_phone, quantity, total_price, payment_status, payment_method, reservation_status, reservation_code, created_at')
    .eq('event_id', params.id)
    .order('created_at', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ reservations: data ?? [] })
}
