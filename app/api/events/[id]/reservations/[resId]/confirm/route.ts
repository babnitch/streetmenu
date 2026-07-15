import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'
import { sendWhatsApp, getLangByPhone, pickLang } from '@/lib/whatsapp'

export const dynamic = 'force-dynamic'

// POST /api/events/[id]/reservations/[resId]/confirm
// Organizer-only action: flip a pending reservation to 'confirmed'.
// Customer gets a WhatsApp ack. Idempotent — re-confirming an already
// confirmed row is a no-op except for the re-ping.
export async function POST(
  req:  NextRequest,
  { params }: { params: { id: string; resId: string } },
) {
  const session = getSessionFromRequest(req)
  if (!session) return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  const isAdmin = ['super_admin', 'admin', 'moderator'].includes(session.role)

  const { data: event } = await supabaseAdmin
    .from('events').select('id, organizer_id, title, date, venue').eq('id', params.id).maybeSingle()
  if (!event) return NextResponse.json({ error: 'Événement introuvable / Event not found' }, { status: 404 })
  if (!isAdmin && event.organizer_id !== session.id) {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 403 })
  }

  const { data: r } = await supabaseAdmin
    .from('event_reservations')
    .select('id, event_id, customer_phone, customer_name, quantity, reservation_status, reservation_code')
    .eq('id', params.resId)
    .eq('event_id', params.id)
    .maybeSingle()
  if (!r) return NextResponse.json({ error: 'Réservation introuvable / Reservation not found' }, { status: 404 })
  if (r.reservation_status === 'cancelled' || r.reservation_status === 'rejected') {
    return NextResponse.json({ error: 'Réservation déjà clôturée / Reservation already closed' }, { status: 409 })
  }

  await supabaseAdmin
    .from('event_reservations')
    .update({ reservation_status: 'confirmed', updated_at: new Date().toISOString() })
    .eq('id', r.id)

  await writeAudit({
    action:          'reservation_confirmed_by_organizer',
    targetType:      'event_reservation',
    targetId:        r.id,
    performedBy:     session.id,
    performedByType: session.role,
    previousData:    { reservation_status: r.reservation_status },
    metadata:        { event_id: event.id },
  })

  if (r.customer_phone) {
    const lang = await getLangByPhone(r.customer_phone)
    const dateStr = new Date(event.date).toLocaleDateString(lang === 'en' ? 'en-GB' : 'fr-FR', {
      day: '2-digit', month: 'long', year: 'numeric',
    })
    const codeStr = r.reservation_code ? ` #${r.reservation_code}` : ''
    await sendWhatsApp(r.customer_phone, [
      pickLang(
        `✅ *Votre réservation${codeStr} pour ${event.title} est confirmée!*`,
        `✅ *Your reservation${codeStr} for ${event.title} is confirmed!*`,
        lang,
      ),
      `📅 ${dateStr}`,
      event.venue ? `📍 ${event.venue}` : '',
      pickLang(`🎟 ${r.quantity} place(s)`, `🎟 ${r.quantity} ticket(s)`, lang),
    ].filter(Boolean).join('\n')).catch(() => null)
  }

  return NextResponse.json({ ok: true })
}
