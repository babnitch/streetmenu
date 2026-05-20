import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'

export const dynamic = 'force-dynamic'

// PATCH /api/events/[id]/reservations-status
// Body: { open: boolean }
// Flips events.reservations_open. Organizer-only (or admin). Used by
// the web dashboard toggle and the WhatsApp "fermer/ouvrir reservations"
// commands. Idempotent — setting the same value is a no-op.
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionFromRequest(req)
  if (!session) return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })

  const isAdmin = ['super_admin', 'admin', 'moderator'].includes(session.role)
  const body = await req.json().catch(() => ({}))
  if (typeof body?.open !== 'boolean') {
    return NextResponse.json({ error: 'open (boolean) requis' }, { status: 400 })
  }

  const { data: event } = await supabaseAdmin
    .from('events').select('id, organizer_id, reservations_open').eq('id', params.id).maybeSingle()
  if (!event) return NextResponse.json({ error: 'Événement introuvable / Event not found' }, { status: 404 })
  if (!isAdmin && event.organizer_id !== session.id) {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 403 })
  }

  await supabaseAdmin
    .from('events')
    .update({ reservations_open: body.open })
    .eq('id', event.id)

  await writeAudit({
    action:          body.open ? 'reservations_opened' : 'reservations_closed',
    targetType:      'event',
    targetId:        event.id,
    performedBy:     session.id,
    performedByType: session.role,
    previousData:    { reservations_open: event.reservations_open },
    metadata:        { open: body.open },
  })

  return NextResponse.json({ ok: true, open: body.open })
}
