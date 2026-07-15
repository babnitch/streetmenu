import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'
import { createDeposit, detectMNO, mnoLabel, countryFromCity } from '@/lib/pawapay'
import { tierAvailability, type TicketTier } from '@/lib/tiers'
import { canPayOnline, normalizeMode, modeFromLegacy } from '@/lib/paymentMode'

export const dynamic = 'force-dynamic'

// POST /api/events/[id]/pay
// Body: { quantity, phoneNumber, customer_name?, customer_phone? }
//
// Mirrors /api/payments/initiate for restaurant orders. Inserts a pending
// event_reservation row, calls PawaPay createDeposit, stores the deposit
// id on the reservation, bumps events.tickets_sold so concurrent buyers
// can't oversell, returns the depositId for client-side polling.
//
// Webhook + status poll in /api/payments/{webhook,status/[depositId]}
// are responsible for flipping payment_status to 'paid' and firing the
// notifyPaidReservation fan-out.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionFromRequest(req)
  const customerId = session?.role === 'customer' ? session.id : null

  const body = await req.json().catch(() => ({}))
  const quantityRaw = Number(body.quantity)
  const quantity = Number.isFinite(quantityRaw) && quantityRaw >= 1 && quantityRaw <= 10
    ? Math.floor(quantityRaw)
    : 1
  const phoneNumber = typeof body.phoneNumber === 'string' ? body.phoneNumber.trim() : ''
  const guestName   = typeof body.customer_name  === 'string' ? body.customer_name.trim()  : ''
  const guestPhone  = typeof body.customer_phone === 'string' ? body.customer_phone.trim() : ''
  // Optional tier_id — when present, price + capacity come from the tier
  // row rather than events.ticket_price. Multi-tier paid checkout is
  // intentionally out of scope for this iteration; the UI buys one tier
  // per PawaPay deposit.
  const tierIdRaw = typeof body.tier_id === 'string' ? body.tier_id.trim() : ''

  if (!phoneNumber) {
    return NextResponse.json({ error: 'phoneNumber requis / required' }, { status: 400 })
  }

  const { data: event, error: evErr } = await supabaseAdmin
    .from('events')
    .select('id, title, city, is_active, event_status, ticket_price, max_tickets, tickets_sold, payment_mode, payment_enabled, commission_rate, reservations_open')
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
  if (!canPayOnline(normalizeMode(event.payment_mode ?? modeFromLegacy(event.payment_enabled)))) {
    return NextResponse.json({
      error: "Paiement en ligne non activé pour cet événement / Online payment not enabled",
    }, { status: 400 })
  }

  // Resolve price + capacity from the tier when provided, otherwise
  // from the event's default ticket_price.
  let tier: TicketTier | null = null
  if (tierIdRaw) {
    const { data: t } = await supabaseAdmin
      .from('event_ticket_tiers').select('*').eq('id', tierIdRaw).eq('event_id', event.id).maybeSingle()
    if (!t) return NextResponse.json({ error: 'Tarif introuvable / Tier not found' }, { status: 404 })
    tier = t as TicketTier
    const avail = tierAvailability(tier)
    if (avail.kind !== 'active') {
      return NextResponse.json({
        error: `Tarif non disponible / Tier not available`,
        state: avail.kind,
      }, { status: 409 })
    }
    const remaining = tier.max_quantity > 0 ? tier.max_quantity - tier.sold_count : Infinity
    if (quantity > remaining) {
      return NextResponse.json({
        error: 'Plus assez de places pour ce tarif / Not enough remaining for this tier',
        remaining: Math.max(0, remaining),
      }, { status: 409 })
    }
  }

  const ticketPrice = tier ? tier.price : (Number(event.ticket_price ?? 0) || 0)
  if (ticketPrice <= 0) {
    return NextResponse.json({
      error: 'Prix du billet invalide / Invalid ticket price',
    }, { status: 400 })
  }

  // Capacity check against the event's global cap (unchanged).
  const sold = Number(event.tickets_sold ?? 0)
  if (event.max_tickets && event.max_tickets > 0 && sold + quantity > event.max_tickets) {
    return NextResponse.json({
      error: 'Plus assez de places / Not enough spots remaining',
      remaining: Math.max(0, event.max_tickets - sold),
    }, { status: 409 })
  }

  // Identity: session > guest body. Same shape as /reserve.
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

  const country = countryFromCity(event.city)
  const mno     = detectMNO(phoneNumber, country ?? undefined)
  if (!mno) {
    return NextResponse.json({ error: 'Numéro non supporté / Unsupported phone number' }, { status: 400 })
  }

  const totalPrice = ticketPrice * quantity
  const commissionRate = Number(event.commission_rate ?? 0.10) || 0.10
  const commissionAmount = Math.round(totalPrice * commissionRate)

  // Pending reservation FIRST so we have an id to thread into PawaPay's
  // statementDescription. Bump tickets_sold under the same write so concurrent
  // callers see the new count immediately.
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
      payment_status:     'pending',
      reservation_status: 'confirmed',
      tier_id:            tier?.id    ?? null,
      tier_name:          tier?.name  ?? null,
      tier_price:         tier?.price ?? null,
    })
    .select('id')
    .single()

  if (insErr || !reservation) {
    console.error('[events/pay] reservation insert failed:', insErr?.message)
    return NextResponse.json({ error: insErr?.message ?? 'Erreur / Error' }, { status: 500 })
  }

  console.log('[events/pay] event=%s tickets_sold %d → %d (+%d)', event.id, sold, sold + quantity, quantity)
  await supabaseAdmin.from('events').update({ tickets_sold: sold + quantity }).eq('id', event.id)
  // Per-tier sold_count bump too, mirroring the free reserve flow so the
  // public picker's "remaining" stays accurate even before the deposit
  // settles. The webhook releases this back on FAILED/REJECTED.
  if (tier) {
    console.log('[events/pay] tier=%s sold_count %d → %d', tier.id, tier.sold_count, tier.sold_count + quantity)
    await supabaseAdmin
      .from('event_ticket_tiers')
      .update({ sold_count: tier.sold_count + quantity, updated_at: new Date().toISOString() })
      .eq('id', tier.id)
  }

  // Now create the deposit. If PawaPay rejects synchronously we leave the
  // reservation as 'pending' and report the error — the user can retry, and
  // the row stays as an artifact for the organizer (matches the existing
  // restaurant-order behaviour where the row stays pending on init failure).
  let depositResult
  try {
    depositResult = await createDeposit({
      amount:      totalPrice,
      currency:    mno.currency,
      phoneNumber,
      orderId:     reservation.id,
      description: `${event.title} ${reservation.id.slice(0, 6)}`,
    })
  } catch (e) {
    const msg = (e as Error).message
    console.error('[events/pay] createDeposit failed:', msg)
    return NextResponse.json({ error: msg }, { status: 502 })
  }

  await supabaseAdmin
    .from('event_reservations')
    .update({
      payment_id:     depositResult.depositId,
      payment_method: depositResult.correspondent,
    })
    .eq('id', reservation.id)

  await writeAudit({
    action:          'event_payment_initiated',
    targetType:      'event_reservation',
    targetId:        reservation.id,
    performedBy:     customerId ?? null,
    performedByType: customerId ? 'customer' : 'guest',
    metadata: {
      event_id:      event.id,
      deposit_id:    depositResult.depositId,
      correspondent: depositResult.correspondent,
      amount:        totalPrice,
      currency:      mno.currency,
      quantity,
    },
  })

  return NextResponse.json({
    ok:             true,
    reservation_id: reservation.id,
    depositId:      depositResult.depositId,
    status:         depositResult.status,
    mno:            depositResult.correspondent,
    mnoLabel:       mnoLabel(depositResult.correspondent),
    currency:       mno.currency,
    amount:         totalPrice,
  })
}
