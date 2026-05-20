import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'
import { sendWhatsApp } from '@/lib/whatsapp'

export const dynamic = 'force-dynamic'

// POST /api/events/[id]/reserve
// Body: { quantity, customer_name?, customer_phone? }
//
// Batch A: free-only reservation path. Events with payment_enabled=true are
// rejected (the paid path lands in Batch B with PawaPay wiring). Pay-at-door
// paid events (ticket_price > 0 + payment_enabled=false) are treated as
// free-reservation here — the price stays on total_price for the organiser's
// records, payment_status remains 'not_required'.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionFromRequest(req)
  const customerId = session?.role === 'customer' ? session.id : null

  const body = await req.json().catch(() => ({}))
  const quantityRaw = Number(body.quantity)
  const quantity = Number.isFinite(quantityRaw) && quantityRaw >= 1 && quantityRaw <= 10
    ? Math.floor(quantityRaw)
    : 1
  const guestName  = typeof body.customer_name  === 'string' ? body.customer_name.trim()  : ''
  const guestPhone = typeof body.customer_phone === 'string' ? body.customer_phone.trim() : ''

  // Pull the event row + needed fields. Active check matches the public read
  // policy so a logged-out user could only ever reserve for events they can
  // already see.
  const { data: event, error: evErr } = await supabaseAdmin
    .from('events')
    .select('id, title, date, time, venue, whatsapp, organizer_id, is_active, event_status, ticket_price, max_tickets, tickets_sold, payment_enabled, commission_rate, requires_confirmation, reservations_open')
    .eq('id', params.id)
    .maybeSingle()

  if (evErr || !event) {
    return NextResponse.json({ error: 'Événement introuvable / Event not found' }, { status: 404 })
  }
  if (!event.is_active) {
    return NextResponse.json({ error: 'Événement non publié / Event not published' }, { status: 403 })
  }
  if (event.event_status && ['cancelled', 'completed'].includes(event.event_status)) {
    return NextResponse.json({ error: 'Événement clôturé / Event closed' }, { status: 409 })
  }
  if (event.reservations_open === false) {
    return NextResponse.json({ error: 'Les réservations sont fermées / Reservations are closed' }, { status: 409 })
  }

  if (event.payment_enabled) {
    // Paid flow lands in Batch B. Tell the client to fall back to the
    // WhatsApp interest button for now.
    return NextResponse.json({
      error: 'Paiement en ligne bientôt disponible / Online payment coming soon',
    }, { status: 501 })
  }

  // Capacity check — max_tickets=0 means unlimited (spec).
  const sold = Number(event.tickets_sold ?? 0)
  if (event.max_tickets && event.max_tickets > 0 && sold + quantity > event.max_tickets) {
    return NextResponse.json({
      error: 'Plus assez de places / Not enough spots remaining',
      remaining: Math.max(0, event.max_tickets - sold),
    }, { status: 409 })
  }

  // Resolve customer identity. Logged-in session wins; otherwise the form
  // values are required.
  let custName  = ''
  let custPhone = ''
  if (customerId) {
    const { data: c } = await supabaseAdmin
      .from('customers').select('name, phone').eq('id', customerId).maybeSingle()
    custName  = c?.name  ?? ''
    custPhone = c?.phone ?? ''
  } else {
    custName  = guestName
    custPhone = guestPhone
  }
  if (!custName || !custPhone) {
    return NextResponse.json({
      error: 'Nom et téléphone requis / Name and phone required',
    }, { status: 400 })
  }

  const ticketPrice = Number(event.ticket_price ?? 0) || 0
  const totalPrice  = ticketPrice * quantity
  // Commission is locked in at reservation time so a later rate change on
  // the event doesn't retroactively shift what the organizer owes.
  const commissionRate = Number(event.commission_rate ?? 0.10) || 0.10
  const commissionAmount = totalPrice > 0 ? Math.round(totalPrice * commissionRate) : 0

  // Manual-approval events land as 'pending' and require the organizer
  // to confirm/reject before the reservation counts toward attendance.
  // Default events stay on the existing auto-confirm path.
  const needsApproval = event.requires_confirmation === true
  const initialStatus: 'pending' | 'confirmed' = needsApproval ? 'pending' : 'confirmed'

  const { data: reservation, error: insErr } = await supabaseAdmin
    .from('event_reservations')
    .insert({
      event_id:           event.id,
      customer_id:        customerId,
      customer_name:      custName,
      customer_phone:     custPhone,
      quantity,
      total_price:        totalPrice,
      commission_amount:  commissionAmount,
      payment_status:     'not_required',
      reservation_status: initialStatus,
    })
    .select('id, quantity, total_price')
    .single()

  if (insErr || !reservation) {
    console.error('[events/reserve] insert failed:', insErr?.message)
    return NextResponse.json({ error: insErr?.message ?? 'Erreur / Error' }, { status: 500 })
  }

  // Bump tickets_sold so the next capacity check sees the new total. Race
  // window exists vs concurrent reservations — acceptable at this scale; a
  // follow-up could move this to an RPC for atomic increment.
  await supabaseAdmin
    .from('events')
    .update({ tickets_sold: sold + quantity })
    .eq('id', event.id)

  await writeAudit({
    action:          'event_reservation_created',
    targetType:      'event_reservation',
    targetId:        reservation.id,
    performedBy:     customerId ?? null,
    performedByType: customerId ? 'customer' : 'guest',
    metadata: {
      event_id:    event.id,
      event_title: event.title,
      quantity,
      total_price: totalPrice,
      paid:        false,
    },
  })

  // Customer ack — short, since the success page on /events/[id] already
  // shows the full summary. Copy + emoji vary depending on whether the
  // reservation is auto-confirmed or awaiting organizer approval.
  const dateStr = new Date(event.date).toLocaleDateString('fr-FR', {
    day: '2-digit', month: 'long', year: 'numeric',
  })
  const priceLine = ticketPrice > 0
    ? `\n💰 Paiement sur place: ${totalPrice.toLocaleString()} FCFA / Pay at the door`
    : ''
  const customerHeader = needsApproval
    ? `⏳ *Votre réservation est en attente / Your reservation is pending*\nL'organisateur doit la confirmer. / The organizer needs to confirm it.`
    : `✅ *Réservation confirmée! / Reservation confirmed!*`
  await sendWhatsApp(custPhone, [
    customerHeader,
    ``,
    `🎉 ${event.title}`,
    `📅 ${dateStr}${event.time ? ` · ${event.time}` : ''}`,
    event.venue ? `📍 ${event.venue}` : '',
    `🎟 ${quantity} place(s) / ticket(s)`,
    priceLine,
  ].filter(Boolean).join('\n')).catch(e => console.warn('[events/reserve] customer ping failed:', (e as Error).message))

  // Organizer ping — use the customer linked via organizer_id if present,
  // otherwise fall back to events.whatsapp. Organizers without either get
  // no notification (acceptable; they can read /account "Mes événements"
  // when that tab ships in Batch C).
  let organizerPhone: string | null = null
  if (event.organizer_id) {
    const { data: o } = await supabaseAdmin
      .from('customers').select('phone').eq('id', event.organizer_id).maybeSingle()
    organizerPhone = o?.phone ?? null
  }
  if (!organizerPhone && event.whatsapp) organizerPhone = event.whatsapp

  if (organizerPhone) {
    const id4 = reservation.id.replace(/-/g, '').slice(-4).toUpperCase()
    const organizerHeader = needsApproval
      ? `📋 *Nouvelle réservation en attente / New reservation pending*\nID #${id4} — répondez "confirmer reservation ${id4}" ou "rejeter reservation ${id4}". / Reply "confirm" or "reject" with the ID.`
      : `🎟 *Nouvelle réservation / New reservation*`
    await sendWhatsApp(organizerPhone, [
      organizerHeader,
      ``,
      `🎉 ${event.title}`,
      `📅 ${dateStr}`,
      `👤 ${custName}`,
      `📱 ${custPhone}`,
      `🎟 ${quantity} place(s)`,
      ticketPrice > 0 ? `💰 ${totalPrice.toLocaleString()} FCFA` : '',
    ].filter(Boolean).join('\n')).catch(e => console.warn('[events/reserve] organizer ping failed:', (e as Error).message))
  }

  return NextResponse.json({
    ok: true,
    reservation_id: reservation.id,
    quantity:       reservation.quantity,
    total_price:    reservation.total_price,
  })
}
