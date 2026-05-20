import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'

export const dynamic = 'force-dynamic'

// PATCH /api/events/[id]/settings
// Body: { requires_confirmation?: boolean, max_tickets?: number }
// Organizer-only. Lets the organizer toggle the manual-approval flag
// and bump capacity from the dashboard (e.g. after selling out the
// initial allotment).
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionFromRequest(req)
  if (!session) return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  const isAdmin = ['super_admin', 'admin', 'moderator'].includes(session.role)

  const body = await req.json().catch(() => ({}))
  const updates: Record<string, unknown> = {}
  if (typeof body?.requires_confirmation === 'boolean') {
    updates.requires_confirmation = body.requires_confirmation
  }
  if (Number.isFinite(body?.max_tickets)) {
    updates.max_tickets = Math.max(0, Math.round(body.max_tickets))
  }
  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'Aucun champ à mettre à jour' }, { status: 400 })
  }

  const { data: event } = await supabaseAdmin
    .from('events').select('id, organizer_id, requires_confirmation, max_tickets').eq('id', params.id).maybeSingle()
  if (!event) return NextResponse.json({ error: 'Événement introuvable / Event not found' }, { status: 404 })
  if (!isAdmin && event.organizer_id !== session.id) {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 403 })
  }

  await supabaseAdmin.from('events').update(updates).eq('id', event.id)

  if ('max_tickets' in updates) {
    await writeAudit({
      action:          'event_capacity_updated',
      targetType:      'event',
      targetId:        event.id,
      performedBy:     session.id,
      performedByType: session.role,
      previousData:    { max_tickets: event.max_tickets },
      metadata:        { max_tickets: updates.max_tickets },
    })
  }
  if ('requires_confirmation' in updates) {
    await writeAudit({
      action:          'event_settings_updated',
      targetType:      'event',
      targetId:        event.id,
      performedBy:     session.id,
      performedByType: session.role,
      previousData:    { requires_confirmation: event.requires_confirmation },
      metadata:        { requires_confirmation: updates.requires_confirmation },
    })
  }

  return NextResponse.json({ ok: true })
}
