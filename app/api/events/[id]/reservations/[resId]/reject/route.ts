import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'
import { sendWhatsApp, getLangByPhone, pickLang } from '@/lib/whatsapp'

export const dynamic = 'force-dynamic'

// POST /api/events/[id]/reservations/[resId]/reject
// Body: { reason?: string }
// Organizer-only action: flip a reservation to 'rejected'. Releases the
// seats back into the pool (decrements events.tickets_sold). When the
// rejected row was a paid reservation, payment_status is left untouched
// — operator refunds the customer manually for now (matches the
// existing cancel path).
export async function POST(
  req:  NextRequest,
  { params }: { params: { id: string; resId: string } },
) {
  const session = getSessionFromRequest(req)
  if (!session) return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  const isAdmin = ['super_admin', 'admin', 'moderator'].includes(session.role)

  const body = await req.json().catch(() => ({}))
  const reason = body?.reason ? String(body.reason) : null

  const { data: event } = await supabaseAdmin
    .from('events').select('id, organizer_id, title, tickets_sold').eq('id', params.id).maybeSingle()
  if (!event) return NextResponse.json({ error: 'Événement introuvable / Event not found' }, { status: 404 })
  if (!isAdmin && event.organizer_id !== session.id) {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 403 })
  }

  const { data: r } = await supabaseAdmin
    .from('event_reservations')
    .select('id, event_id, customer_phone, customer_name, quantity, reservation_status, payment_status, reservation_code')
    .eq('id', params.resId)
    .eq('event_id', params.id)
    .maybeSingle()
  if (!r) return NextResponse.json({ error: 'Réservation introuvable / Reservation not found' }, { status: 404 })
  if (r.reservation_status === 'rejected' || r.reservation_status === 'cancelled') {
    return NextResponse.json({ error: 'Réservation déjà clôturée / Reservation already closed' }, { status: 409 })
  }

  // Release seats back. Same race-window caveat as the reserve path —
  // acceptable at this scale; concurrent rejects could under-decrement
  // briefly but never persist a wrong total because no second-pass
  // counter exists.
  const nextSold = Math.max(0, Number(event.tickets_sold ?? 0) - Number(r.quantity ?? 0))
  console.log('[events/reject] event=%s tickets_sold %d → %d (-%d)', event.id, Number(event.tickets_sold ?? 0), nextSold, Number(r.quantity ?? 0))
  await Promise.all([
    supabaseAdmin
      .from('event_reservations')
      .update({ reservation_status: 'rejected', updated_at: new Date().toISOString() })
      .eq('id', r.id),
    supabaseAdmin
      .from('events').update({ tickets_sold: nextSold }).eq('id', event.id),
  ])

  await writeAudit({
    action:          'reservation_rejected',
    targetType:      'event_reservation',
    targetId:        r.id,
    performedBy:     session.id,
    performedByType: session.role,
    previousData:    { reservation_status: r.reservation_status, payment_status: r.payment_status },
    metadata:        { event_id: event.id, reason, was_paid: r.payment_status === 'paid' },
  })

  if (r.customer_phone) {
    const lang = await getLangByPhone(r.customer_phone)
    const codeStr = r.reservation_code ? ` #${r.reservation_code}` : ''
    await sendWhatsApp(r.customer_phone, [
      pickLang(
        `❌ *Votre réservation${codeStr} pour ${event.title} a été refusée.*`,
        `❌ *Your reservation${codeStr} for ${event.title} has been declined.*`,
        lang,
      ),
      reason ? `\n📝 ${reason}` : '',
      r.payment_status === 'paid'
        ? pickLang(
            `💰 Le remboursement sera traité par l'organisateur.`,
            `💰 The organizer will process a refund.`,
            lang,
          )
        : '',
    ].filter(Boolean).join('\n')).catch(() => null)
  }

  return NextResponse.json({ ok: true })
}
