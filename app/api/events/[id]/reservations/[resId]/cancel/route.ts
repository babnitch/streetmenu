import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'
import { sendWhatsApp, getLangByPhone, pickLang } from '@/lib/whatsapp'

export const dynamic = 'force-dynamic'

// POST /api/events/[id]/reservations/[resId]/cancel
// Allowed roles:
//   - the reservation's customer (self-cancel)
//   - the event organizer (organizer_id match)
//   - admins
// Releases the seats back to tickets_sold so a cancellation immediately
// frees capacity. PawaPay-paid cancellations are flagged in the audit
// log + customer message — actual refund is out of band for now.
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string; resId: string } },
) {
  const session = getSessionFromRequest(req)
  if (!session) return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })

  const isAdmin = ['super_admin', 'admin', 'moderator'].includes(session.role)

  const { data: r } = await supabaseAdmin
    .from('event_reservations')
    .select('id, event_id, customer_id, customer_name, customer_phone, quantity, payment_status, reservation_status, total_price, reservation_code')
    .eq('id', params.resId).eq('event_id', params.id).maybeSingle()
  if (!r) return NextResponse.json({ error: 'Réservation introuvable / Reservation not found' }, { status: 404 })
  if (r.reservation_status === 'cancelled') {
    return NextResponse.json({ ok: true, ignored: 'already cancelled' })
  }

  const { data: event } = await supabaseAdmin
    .from('events').select('id, title, date, organizer_id, tickets_sold').eq('id', params.id).maybeSingle()
  if (!event) return NextResponse.json({ error: 'Événement introuvable / Event not found' }, { status: 404 })

  // Authz: customer self-cancel, organizer, or admin.
  const isOrganizer = event.organizer_id && event.organizer_id === session.id
  const isOwner     = r.customer_id && r.customer_id === session.id
  if (!isAdmin && !isOrganizer && !isOwner) {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 403 })
  }

  // Body may carry an optional reason — surfaced in the audit row.
  const body = await req.json().catch(() => ({}))
  const reason = typeof body?.reason === 'string' ? body.reason.trim().slice(0, 200) : null

  const sold = Number(event.tickets_sold ?? 0)
  const nextSold = Math.max(0, sold - Number(r.quantity ?? 0))
  console.log('[events/cancel] event=%s tickets_sold %d → %d (-%d)', event.id, sold, nextSold, Number(r.quantity ?? 0))

  await Promise.all([
    supabaseAdmin
      .from('event_reservations')
      .update({ reservation_status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('id', r.id),
    supabaseAdmin
      .from('events').update({ tickets_sold: nextSold }).eq('id', event.id),
  ])

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
  const fmtDate = (l: string) => new Date(event.date).toLocaleDateString(l === 'en' ? 'en-GB' : 'fr-FR', {
    day: '2-digit', month: 'long', year: 'numeric',
  })
  const codeStr = r.reservation_code ? ` #${r.reservation_code}` : ''
  if (isOwner) {
    let organizerPhone: string | null = null
    if (event.organizer_id) {
      const { data: o } = await supabaseAdmin
        .from('customers').select('phone').eq('id', event.organizer_id).maybeSingle()
      organizerPhone = o?.phone ?? null
    }
    if (!organizerPhone) {
      const { data: ev2 } = await supabaseAdmin
        .from('events').select('whatsapp').eq('id', event.id).maybeSingle()
      organizerPhone = ev2?.whatsapp ?? null
    }
    if (organizerPhone) {
      const orgLang = await getLangByPhone(organizerPhone)
      await sendWhatsApp(organizerPhone, [
        pickLang(`❌ *Réservation${codeStr} annulée*`, `❌ *Reservation${codeStr} cancelled*`, orgLang),
        ``,
        `🎉 ${event.title}`,
        `📅 ${fmtDate(orgLang)}`,
        `👤 ${r.customer_name}`,
        `📱 ${r.customer_phone}`,
        pickLang(`🎟 ${r.quantity} place(s)`, `🎟 ${r.quantity} ticket(s)`, orgLang),
        reason ? `📝 ${reason}` : '',
      ].filter(Boolean).join('\n')).catch(() => null)
    }
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
      ].filter(Boolean).join('\n')).catch(() => null)
    }
  }

  return NextResponse.json({
    ok: true,
    needs_refund: r.payment_status === 'paid',
  })
}
