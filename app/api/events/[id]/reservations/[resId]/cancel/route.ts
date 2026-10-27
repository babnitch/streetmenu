import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { notifyOrganizer } from '@/lib/eventRecipients'
import { getSessionFromRequest } from '@/lib/auth'
import { isEventOrganizer } from '@/lib/eventAuth'
import { writeAudit } from '@/lib/audit'
import { sendWhatsApp, getLangByPhone, pickLang, type Lang } from '@/lib/whatsapp'
import { EVENT_DATE_COLUMNS, formatEventDates, isPastEvent } from '@/lib/eventDate'
import { closeReservation, OPEN_RESERVATION_STATUSES } from '@/lib/eventSeats'

export const dynamic = 'force-dynamic'

// POST /api/events/[id]/reservations/[resId]/cancel
// Allowed roles:
//   - the reservation's customer (self-cancel) — unpaid bookings of an
//     upcoming event only; a PAID ticket must be cancelled by the organizer
//   - the event organizer (organizer_id match)
//   - admins
// Only pending/confirmed reservations can be cancelled, never while their
// MoMo payment is still in flight. Releases the seats (event total AND tier)
// exactly once, via closeReservation. PawaPay-paid cancellations are flagged
// in the audit log + customer message — actual refund is out of band for now.
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string; resId: string } },
) {
  const session = getSessionFromRequest(req)
  if (!session) return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })

  const isAdmin = ['super_admin', 'admin', 'moderator'].includes(session.role)

  const { data: r } = await supabaseAdmin
    .from('event_reservations')
    .select('id, event_id, customer_id, customer_name, customer_phone, quantity, tier_id, payment_status, reservation_status, total_price, reservation_code')
    .eq('id', params.resId).eq('event_id', params.id).maybeSingle()
  if (!r) return NextResponse.json({ error: 'Réservation introuvable / Reservation not found' }, { status: 404 })
  if (r.reservation_status === 'cancelled') {
    return NextResponse.json({ ok: true, ignored: 'already cancelled' })
  }

  const { data: event } = await supabaseAdmin
    .from('events').select(`id, title, ${EVENT_DATE_COLUMNS}, organizer_id, submitted_by`).eq('id', params.id).maybeSingle()
  if (!event) return NextResponse.json({ error: 'Événement introuvable / Event not found' }, { status: 404 })

  // Authz: customer self-cancel, organizer, or admin.
  const isOrganizer = isEventOrganizer(event, session.id)
  const isOwner     = r.customer_id && r.customer_id === session.id
  if (!isAdmin && !isOrganizer && !isOwner) {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 403 })
  }

  if (!(OPEN_RESERVATION_STATUSES as readonly string[]).includes(r.reservation_status)) {
    return NextResponse.json(
      { error: 'Cette réservation ne peut plus être annulée. / This reservation can no longer be cancelled.' },
      { status: 409 },
    )
  }

  // Customer self-cancel rules. The organizer and admins are not bound by
  // them (they can cancel a paid ticket; needs_refund is audited below).
  const selfCancel = !!isOwner && !isAdmin && !isOrganizer
  if (selfCancel && r.payment_status === 'paid') {
    return NextResponse.json(
      { error: "Contactez l'organisateur pour annuler un billet payé. / Contact the organiser to cancel a paid ticket." },
      { status: 403 },
    )
  }
  if (selfCancel && isPastEvent(event)) {
    return NextResponse.json(
      { error: 'Événement passé — annulation impossible. / This event is over — it can no longer be cancelled.' },
      { status: 409 },
    )
  }
  if (r.payment_status === 'pending') {
    return NextResponse.json(
      { error: 'Paiement en cours — réessayez dans quelques minutes. / Payment in progress — try again in a few minutes.' },
      { status: 409 },
    )
  }

  // Body may carry an optional reason — surfaced in the audit row.
  const body = await req.json().catch(() => ({}))
  const reason = typeof body?.reason === 'string' ? body.reason.trim().slice(0, 200) : null

  // Conditional transition: only the request that actually moves the row
  // releases its seats, so a double click or a second tab can't release
  // them twice.
  let closed
  try {
    closed = await closeReservation(r.id, 'cancelled')
  } catch (e) {
    console.error('[events/cancel] failed:', (e as Error).message)
    return NextResponse.json({ error: 'Erreur — réessayez. / Error — please try again.' }, { status: 500 })
  }
  if (!closed) {
    return NextResponse.json(
      { error: 'Réservation déjà modifiée — actualisez. / Reservation already changed — refresh.' },
      { status: 409 },
    )
  }
  console.log('[events/cancel] reservation=%s event=%s released %d seat(s) tier=%s', r.id, event.id, Number(r.quantity ?? 0), r.tier_id ?? '-')

  const cancelledBy = isAdmin ? session.role : (isOrganizer ? 'organizer' : 'customer')
  await writeAudit({
    action:          'event_reservation_cancelled',
    targetType:      'event_reservation',
    targetId:        r.id,
    performedBy:     session.id,
    performedByType: cancelledBy,
    previousData:    { reservation_status: r.reservation_status, payment_status: r.payment_status },
    metadata: {
      event_id:        event.id,
      event_title:     event.title,
      quantity:        r.quantity,
      total_price:     r.total_price,
      reason,
      needs_refund:    r.payment_status === 'paid',
      cancelled_by:    cancelledBy,
    },
  })

  // Notify the other party. Customer self-cancel → ping organizer; organizer
  // or admin cancel → ping customer. The cancelling party gets a 200 instead
  // of a redundant message.
  // Each recipient's date is formatted in THEIR language below (organizer vs
  // customer) — not a single shared locale.
  const fmtDate = (l: Lang) => formatEventDates(event, l, 'message')
  const codeStr = r.reservation_code ? ` #${r.reservation_code}` : ''
  if (isOwner) {
    // Organiser side: account phone + the event's extra notification number.
    await notifyOrganizer(event, orgLang => [
      pickLang(`❌ *Réservation${codeStr} annulée*`, `❌ *Reservation${codeStr} cancelled*`, orgLang),
      ``,
      `🎉 ${event.title}`,
      `📅 ${fmtDate(orgLang)}`,
      `👤 ${r.customer_name}`,
      `📱 ${r.customer_phone}`,
      pickLang(`🎟 ${r.quantity} place(s)`, `🎟 ${r.quantity} ticket(s)`, orgLang),
      reason ? `📝 ${reason}` : '',
    ].filter(Boolean).join('\n'), { context: 'event_reservation', relatedId: event.id })
  } else {
    // Organizer / admin cancelling. Tell the customer.
    if (r.customer_phone) {
      const custLang = await getLangByPhone(r.customer_phone)
      const refundLine = r.payment_status === 'paid'
        ? pickLang(
            `\n💰 ${(r.total_price ?? 0).toLocaleString()} FCFA — l'organisateur vous contactera pour le remboursement.`,
            `\n💰 ${(r.total_price ?? 0).toLocaleString()} FCFA — the organizer will contact you for a refund.`,
            custLang,
          )
        : ''
      await sendWhatsApp(r.customer_phone, [
        pickLang(
          `❌ *Votre réservation${codeStr} pour ${event.title} a été annulée.*`,
          `❌ *Your reservation${codeStr} for ${event.title} has been cancelled.*`,
          custLang,
        ),
        `📅 ${fmtDate(custLang)}`,
        pickLang(`🎟 ${r.quantity} place(s)`, `🎟 ${r.quantity} ticket(s)`, custLang),
        reason ? `📝 ${reason}` : '',
        refundLine,
      ].filter(Boolean).join('\n'), { context: 'event_reservation', relatedId: event.id, customerId: r.customer_id ?? null }).catch(() => null)
    }
  }

  return NextResponse.json({
    ok: true,
    needs_refund: r.payment_status === 'paid',
  })
}
