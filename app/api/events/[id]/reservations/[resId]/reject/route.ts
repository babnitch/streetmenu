import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { isEventOrganizer } from '@/lib/eventAuth'
import { writeAudit } from '@/lib/audit'
import { sendWhatsApp, getLangByPhone, pickLang } from '@/lib/whatsapp'
import { closeReservation } from '@/lib/eventSeats'

export const dynamic = 'force-dynamic'

// POST /api/events/[id]/reservations/[resId]/reject
// Body: { reason?: string }
// Organizer-only action: flip a pending/confirmed reservation to 'rejected'.
// Releases its seats (event total AND tier) exactly once, via
// closeReservation. Refused while its MoMo payment is in flight. When the
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
    .from('events').select('id, organizer_id, submitted_by, title').eq('id', params.id).maybeSingle()
  if (!event) return NextResponse.json({ error: 'Événement introuvable / Event not found' }, { status: 404 })
  if (!isAdmin && !isEventOrganizer(event, session.id)) {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 403 })
  }

  const { data: r } = await supabaseAdmin
    .from('event_reservations')
    .select('id, event_id, customer_id, customer_phone, customer_name, quantity, reservation_status, payment_status, reservation_code')
    .eq('id', params.resId)
    .eq('event_id', params.id)
    .maybeSingle()
  if (!r) return NextResponse.json({ error: 'Réservation introuvable / Reservation not found' }, { status: 404 })
  if (r.reservation_status === 'rejected' || r.reservation_status === 'cancelled') {
    return NextResponse.json({ error: 'Réservation déjà clôturée / Reservation already closed' }, { status: 409 })
  }

  if (r.payment_status === 'pending') {
    return NextResponse.json(
      { error: 'Paiement en cours — réessayez dans quelques minutes. / Payment in progress — try again in a few minutes.' },
      { status: 409 },
    )
  }

  let closed
  try {
    closed = await closeReservation(r.id, 'rejected')
  } catch (e) {
    console.error('[events/reject] failed:', (e as Error).message)
    return NextResponse.json({ error: 'Erreur — réessayez. / Error — please try again.' }, { status: 500 })
  }
  if (!closed) {
    return NextResponse.json({ error: 'Réservation déjà clôturée / Reservation already closed' }, { status: 409 })
  }
  console.log('[events/reject] reservation=%s event=%s released %d seat(s)', r.id, event.id, Number(r.quantity ?? 0))

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
    ].filter(Boolean).join('\n'), { context: 'event_reservation', relatedId: event.id, customerId: r.customer_id ?? null }).catch(() => null)
  }

  return NextResponse.json({ ok: true })
}
