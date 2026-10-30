import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { organizerPhones } from '@/lib/eventRecipients'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'
import { sendWhatsApp, getLangByPhone, pickLang } from '@/lib/whatsapp'

export const dynamic = 'force-dynamic'

// POST /api/admin/events/[id]/reject
// Body: { reason?: string }
// Admin/moderator rejects: never deleted (soft deletion rule). The event is
// hidden (is_active=false), event_status='rejected' + who / when / why, and
// shows only in Admin → Événements → Rejetés. Audited, submitter pinged.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionFromRequest(req)
  if (!session || !['super_admin', 'admin', 'moderator'].includes(session.role)) {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }

  const body = await req.json().catch(() => ({}))
  const reason = typeof body?.reason === 'string' ? body.reason.trim().slice(0, 500) : null

  const { data: event } = await supabaseAdmin
    .from('events')
    .select('id, title, organizer_id, is_active, event_status, whatsapp, notify_phone')
    .eq('id', params.id)
    .maybeSingle()
  if (!event) return NextResponse.json({ error: 'Événement introuvable / Event not found' }, { status: 404 })
  if (event.event_status === 'rejected') {
    return NextResponse.json({ error: 'Déjà rejeté / Already rejected' }, { status: 409 })
  }

  // Account phone + the event's extra notification number.
  const organizerNumbers = await organizerPhones(event)

  const { error: upErr } = await supabaseAdmin.from('events').update({
    is_active: false, is_featured: false, event_status: 'rejected',
    rejected_at: new Date().toISOString(), rejected_by: session.id, rejection_reason: reason,
  }).eq('id', event.id)
  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 })

  await writeAudit({
    action:          'event_rejected',
    targetType:      'event',
    targetId:        event.id,
    performedBy:     session.id,
    performedByType: session.role,
    previousData:    { title: event.title, organizer_id: event.organizer_id, is_active: event.is_active, event_status: event.event_status },
    metadata:        { reason },
  })

  for (const phone of organizerNumbers) {
    const lang = await getLangByPhone(phone)
    await sendWhatsApp(phone, pickLang(
      `❌ *Événement non approuvé*\n\n🎉 ${event.title}${reason ? `\n📝 Raison: ${reason}` : ''}\n\n` +
      `Contactez le support pour plus d'infos.`,
      `❌ *Event not approved*\n\n🎉 ${event.title}${reason ? `\n📝 Reason: ${reason}` : ''}\n\n` +
      `Contact support for more details.`,
      lang,
    ), { context: 'event_update', relatedId: event.id }).catch(() => null)
  }

  return NextResponse.json({ ok: true })
}
