import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'
import { sendWhatsApp } from '@/lib/whatsapp'

export const dynamic = 'force-dynamic'

// POST /api/admin/events/[id]/reject
// Body: { reason?: string }
// Admin/moderator deletes the row (keeps the public events table free of
// rejected drafts), audits the action with the reason, pings the submitter.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionFromRequest(req)
  if (!session || !['super_admin', 'admin', 'moderator'].includes(session.role)) {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }

  const body = await req.json().catch(() => ({}))
  const reason = typeof body?.reason === 'string' ? body.reason.trim().slice(0, 500) : null

  const { data: event } = await supabaseAdmin
    .from('events')
    .select('id, title, organizer_id, is_active')
    .eq('id', params.id)
    .maybeSingle()
  if (!event) return NextResponse.json({ error: 'Événement introuvable / Event not found' }, { status: 404 })

  // Capture submitter before the delete so we can ping them — the ON DELETE
  // SET NULL on organizer_id would lose the link otherwise.
  let organizerPhone: string | null = null
  if (event.organizer_id) {
    const { data: o } = await supabaseAdmin
      .from('customers').select('phone').eq('id', event.organizer_id).maybeSingle()
    organizerPhone = o?.phone ?? null
  }

  const { error: delErr } = await supabaseAdmin.from('events').delete().eq('id', event.id)
  if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 })

  await writeAudit({
    action:          'event_rejected',
    targetType:      'event',
    targetId:        event.id,
    performedBy:     session.id,
    performedByType: session.role,
    previousData:    { title: event.title, organizer_id: event.organizer_id, is_active: event.is_active },
    metadata:        { reason },
  })

  if (organizerPhone) {
    const reasonLine = reason ? `\n📝 Raison / Reason: ${reason}` : ''
    await sendWhatsApp(organizerPhone,
      `❌ *Événement non approuvé / Event not approved*\n\n🎉 ${event.title}${reasonLine}\n\n` +
      `Contactez le support pour plus d'infos. / Contact support for more details.`,
    ).catch(() => null)
  }

  return NextResponse.json({ ok: true })
}
