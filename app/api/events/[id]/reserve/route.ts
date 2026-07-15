import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'
import { sendWhatsApp, getLangByPhone, pickLang } from '@/lib/whatsapp'
import { tierAvailability, type TicketTier } from '@/lib/tiers'
import { canReserve, normalizeMode, modeFromLegacy } from '@/lib/paymentMode'
import { generateReservationCodes } from '@/lib/reservationCode'
import { validateVoucher, consumeVoucherForReservation } from '@/lib/vouchers'

export const dynamic = 'force-dynamic'

// POST /api/events/[id]/reserve
//
// Body — two shapes accepted:
//
//   A) { quantity, customer_name?, customer_phone? }      (legacy / no tiers)
//      Used by single-price events. One reservation row is inserted with
//      tier_* = null.
//
//   B) { items: [{ tier_id, quantity }], customer_name?, customer_phone? }
//      Used by tier-priced events. One reservation row is inserted per
//      requested tier; each row carries a snapshot of tier_id +
//      tier_name + tier_price so the customer/admin history survives
//      later renames or deactivations.
//
// Free + pay-at-door only. payment_enabled=true events route through
// /pay (PawaPay) — that handler mirrors this validation.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionFromRequest(req)
  const customerId = session?.role === 'customer' ? session.id : null

  const body = await req.json().catch(() => ({}))
  const guestName  = typeof body.customer_name  === 'string' ? body.customer_name.trim()  : ''
  const guestPhone = typeof body.customer_phone === 'string' ? body.customer_phone.trim() : ''

  const { data: event, error: evErr } = await supabaseAdmin
    .from('events')
    .select('id, title, date, time, venue, whatsapp, organizer_id, is_active, event_status, ticket_price, max_tickets, tickets_sold, payment_mode, payment_enabled, commission_rate, requires_confirmation, reservations_open')
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
  // Reservation is allowed for reservation_only and both. Only payment_only
  // (online payment mandatory) blocks the reserve path — those route via /pay.
  // Free events always collapse to reservation_only, so they pass here.
  const isFreeEvent = !(Number(event.ticket_price ?? 0) > 0)
  if (!canReserve(normalizeMode(event.payment_mode ?? modeFromLegacy(event.payment_enabled))) && !isFreeEvent) {
    return NextResponse.json({
      error: 'Paiement en ligne requis / Online payment required',
    }, { status: 501 })
  }

  // ── Resolve customer identity ────────────────────────────────────────────
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

  // ── Items-shaped vs legacy single-quantity ───────────────────────────────
  type Item = { tier_id: string; quantity: number }
  const rawItems = Array.isArray(body.items) ? body.items : null
  const items: Item[] = rawItems
    ? rawItems
        .map((i: { tier_id?: unknown; quantity?: unknown }) => ({
          tier_id:  String(i?.tier_id ?? '').trim(),
          quantity: Number.isFinite(i?.quantity) ? Math.floor(Number(i.quantity)) : 0,
        }))
        .filter((i: Item) => i.tier_id && i.quantity > 0 && i.quantity <= 10)
    : []

  const useTiers = items.length > 0
  const needsApproval = event.requires_confirmation === true
  const initialStatus: 'pending' | 'confirmed' = needsApproval ? 'pending' : 'confirmed'
  const commissionRate = Number(event.commission_rate ?? 0.10) || 0.10
  const sold = Number(event.tickets_sold ?? 0)

  // Build the row list to insert. The legacy path is fully isomorphic
  // with a one-element item list whose tier_id is null.
  type RowToInsert = {
    quantity:   number
    total_price: number
    commission_amount: number
    tier_id:    string | null
    tier_name:  string | null
    tier_price: number | null
  }
  const rowsToInsert: RowToInsert[] = []
  // Tracks tier.sold_count bumps per tier_id for the post-insert update.
  const tierBumps: Map<string, { newSold: number; row: TicketTier }> = new Map()

  if (useTiers) {
    const { data: tierRows, error: tierErr } = await supabaseAdmin
      .from('event_ticket_tiers')
      .select('*')
      .eq('event_id', event.id)
      .in('id', items.map(i => i.tier_id))
    if (tierErr) {
      return NextResponse.json({ error: tierErr.message }, { status: 500 })
    }
    const byId = new Map(((tierRows ?? []) as TicketTier[]).map(t => [t.id, t]))
    for (const item of items) {
      const tier = byId.get(item.tier_id)
      if (!tier) {
        return NextResponse.json({ error: `Tarif introuvable / Tier not found: ${item.tier_id}` }, { status: 404 })
      }
      const avail = tierAvailability(tier)
      if (avail.kind !== 'active') {
        return NextResponse.json({
          error: `Tarif non disponible / Tier not available: ${tier.name}`,
          tier_id: tier.id,
          state:   avail.kind,
        }, { status: 409 })
      }
      const remaining = tier.max_quantity > 0 ? tier.max_quantity - tier.sold_count : Infinity
      if (item.quantity > remaining) {
        return NextResponse.json({
          error: `Plus assez de places pour ${tier.name} / Not enough remaining`,
          remaining: Math.max(0, remaining),
          tier_id:   tier.id,
        }, { status: 409 })
      }
      const linePrice = tier.price * item.quantity
      rowsToInsert.push({
        quantity:          item.quantity,
        total_price:       linePrice,
        commission_amount: linePrice > 0 ? Math.round(linePrice * commissionRate) : 0,
        tier_id:           tier.id,
        tier_name:         tier.name,
        tier_price:        tier.price,
      })
      tierBumps.set(tier.id, { newSold: tier.sold_count + item.quantity, row: tier })
    }
  } else {
    const qty = Number(body.quantity)
    const quantity = Number.isFinite(qty) && qty >= 1 && qty <= 10 ? Math.floor(qty) : 1
    if (event.max_tickets && event.max_tickets > 0 && sold + quantity > event.max_tickets) {
      return NextResponse.json({
        error: 'Plus assez de places / Not enough spots remaining',
        remaining: Math.max(0, event.max_tickets - sold),
      }, { status: 409 })
    }
    const ticketPrice = Number(event.ticket_price ?? 0) || 0
    const linePrice = ticketPrice * quantity
    rowsToInsert.push({
      quantity,
      total_price:       linePrice,
      commission_amount: linePrice > 0 ? Math.round(linePrice * commissionRate) : 0,
      tier_id:           null,
      tier_name:         null,
      tier_price:        null,
    })
  }

  // ── Insert reservation rows ──────────────────────────────────────────────
  const totalQuantity = rowsToInsert.reduce((s, r) => s + r.quantity, 0)
  const totalPrice    = rowsToInsert.reduce((s, r) => s + r.total_price, 0)

  // Aggregate-capacity gate when using tiers but the event also has a
  // global max_tickets — both caps must hold.
  if (useTiers && event.max_tickets && event.max_tickets > 0 && sold + totalQuantity > event.max_tickets) {
    return NextResponse.json({
      error: 'Plus assez de places / Not enough spots remaining',
      remaining: Math.max(0, event.max_tickets - sold),
    }, { status: 409 })
  }

  // ── Promo code / voucher ───────────────────────────────────────────────────
  // Validated server-side against THIS event (event-scoped or platform-wide
  // vouchers pass; restaurant-scoped codes reject). The discount applies to the
  // whole booking subtotal, then is distributed across rows so each row stores
  // its discounted total_price + its share of the discount, and commission is
  // recomputed off the discounted line. Only meaningful for paid bookings.
  const voucherInput = typeof body.voucher_code === 'string' ? body.voucher_code.trim() : ''
  let appliedVoucher: { id: string; code: string } | null = null
  let discountTotal = 0
  const rowDiscounts  = new Array<number>(rowsToInsert.length).fill(0)
  const rowVoucherCode = new Array<string | null>(rowsToInsert.length).fill(null)
  if (voucherInput && totalPrice > 0) {
    const vres = await validateVoucher(voucherInput, { customerId, eventId: event.id, orderTotal: totalPrice })
    if (!vres.ok) {
      return NextResponse.json({ error: vres.message, voucher_rejected: vres.reason }, { status: 422 })
    }
    appliedVoucher = { id: vres.voucher.id, code: vres.voucher.code }
    discountTotal  = vres.discount
    let remaining = discountTotal
    rowsToInsert.forEach((r, idx) => {
      const isLast = idx === rowsToInsert.length - 1
      const share  = isLast ? remaining : (totalPrice > 0 ? Math.round(discountTotal * r.total_price / totalPrice) : 0)
      remaining -= share
      rowDiscounts[idx]   = share
      rowVoucherCode[idx] = vres.voucher.code
      r.total_price       = Math.max(0, r.total_price - share)
      r.commission_amount = r.total_price > 0 ? Math.round(r.total_price * commissionRate) : 0
    })
  }
  const finalTotal = Math.max(0, totalPrice - discountTotal)

  // One unique short code per inserted row (customers quote it; organizers
  // check people in by it). Multi-tier bookings insert several rows, each
  // with its own code.
  const codes = await generateReservationCodes(rowsToInsert.length)
  const insertPayload = rowsToInsert.map((r, idx) => ({
    event_id:           event.id,
    customer_id:        customerId,
    customer_name:      custName,
    customer_phone:     custPhone,
    quantity:           r.quantity,
    total_price:        r.total_price,
    commission_amount:  r.commission_amount,
    discount_amount:    rowDiscounts[idx],
    voucher_code:       rowVoucherCode[idx],
    payment_status:     'not_required',
    reservation_status: initialStatus,
    reservation_code:   codes[idx],
    tier_id:            r.tier_id,
    tier_name:          r.tier_name,
    tier_price:         r.tier_price,
  }))

  const { data: inserted, error: insErr } = await supabaseAdmin
    .from('event_reservations')
    .insert(insertPayload)
    .select('id, quantity, total_price, tier_id, tier_name, reservation_code')
  if (insErr || !inserted || inserted.length === 0) {
    console.error('[events/reserve] insert failed:', insErr?.message)
    return NextResponse.json({ error: insErr?.message ?? 'Erreur / Error' }, { status: 500 })
  }

  // Bump global tickets_sold + per-tier sold_count by the RESERVED QUANTITY
  // (not +1). Race-window same as the legacy code — acceptable at this scale.
  const nextSold = sold + totalQuantity
  console.log('[events/reserve] event=%s tickets_sold %d → %d (+%d across %d row(s))',
    event.id, sold, nextSold, totalQuantity, rowsToInsert.length)
  await supabaseAdmin
    .from('events')
    .update({ tickets_sold: nextSold })
    .eq('id', event.id)
  const bumps = Array.from(tierBumps.values())
  for (const { newSold, row } of bumps) {
    console.log('[events/reserve] tier=%s sold_count %d → %d', row.id, row.sold_count, newSold)
    await supabaseAdmin
      .from('event_ticket_tiers')
      .update({ sold_count: newSold, updated_at: new Date().toISOString() })
      .eq('id', row.id)
  }

  // Consume the voucher once the reservation is committed — increments uses +
  // marks the customer's claim used. Best-effort (never throws).
  if (appliedVoucher) {
    await consumeVoucherForReservation(appliedVoucher.id, customerId)
    console.log('[events/reserve] voucher %s applied: -%d FCFA (%d → %d)', appliedVoucher.code, discountTotal, totalPrice, finalTotal)
  }

  await writeAudit({
    action:          'event_reservation_created',
    targetType:      'event_reservation',
    targetId:        inserted[0].id,
    performedBy:     customerId ?? null,
    performedByType: customerId ? 'customer' : 'guest',
    metadata: {
      event_id:    event.id,
      event_title: event.title,
      quantity:    totalQuantity,
      total_price: finalTotal,
      original_price: totalPrice,
      voucher_code:   appliedVoucher?.code ?? null,
      discount_amount: discountTotal,
      paid:        false,
      reservation_ids: inserted.map(r => r.id),
      tiers:       useTiers ? inserted.map(r => ({ tier_name: r.tier_name, qty: r.quantity })) : null,
    },
  })

  // ── Customer + organizer pings ───────────────────────────────────────────
  // Tier name lines are language-neutral data (name + FCFA); the non-tier
  // fallback is the only piece that needs localising, so build it per lang.
  const tierLinesFor = (lang: 'fr' | 'en') => useTiers
    ? inserted.map(r => `🎟 ${r.tier_name} × ${r.quantity}${r.total_price > 0 ? ` — ${Number(r.total_price).toLocaleString()} FCFA` : ''}`)
    : [pickLang(`🎟 ${totalQuantity} place(s)`, `🎟 ${totalQuantity} ticket(s)`, lang)]

  // Primary reservation code (shown prominently). Multi-tier bookings list
  // all their codes; the common single-row case shows just one.
  const primaryCode = inserted[0].reservation_code as string
  const codeLineFor = (lang: 'fr' | 'en') => inserted.length > 1
    ? pickLang(
        `🎟 Codes de réservation: ${inserted.map(r => `#${r.reservation_code}`).join(', ')}`,
        `🎟 Reservation codes: ${inserted.map(r => `#${r.reservation_code}`).join(', ')}`,
        lang,
      )
    : pickLang(`🎟 Code de réservation: *#${primaryCode}*`, `🎟 Reservation code: *#${primaryCode}*`, lang)

  const custLang = await getLangByPhone(custPhone)
  const dateStr = new Date(event.date).toLocaleDateString(custLang === 'en' ? 'en-GB' : 'fr-FR', {
    day: '2-digit', month: 'long', year: 'numeric',
  })
  // Discount line shown to both parties when a voucher applied.
  const discountLineFor = (lang: 'fr' | 'en') => appliedVoucher && discountTotal > 0
    ? pickLang(
        `🎫 Code ${appliedVoucher.code}: -${discountTotal.toLocaleString()} FCFA`,
        `🎫 Code ${appliedVoucher.code}: -${discountTotal.toLocaleString()} FCFA`,
        lang,
      )
    : ''
  const priceLine = finalTotal > 0
    ? pickLang(
        `\n💰 Paiement sur place: ${finalTotal.toLocaleString()} FCFA`,
        `\n💰 Pay at the door: ${finalTotal.toLocaleString()} FCFA`,
        custLang,
      )
    : ''
  const customerHeader = needsApproval
    ? pickLang(
        `⏳ *Votre réservation est en attente*\nL'organisateur doit la confirmer.`,
        `⏳ *Your reservation is pending*\nThe organizer needs to confirm it.`,
        custLang,
      )
    : pickLang(`✅ *Réservation confirmée!*`, `✅ *Reservation confirmed!*`, custLang)
  await sendWhatsApp(custPhone, [
    customerHeader,
    ``,
    `🎉 ${event.title}`,
    `📅 ${dateStr}${event.time ? ` · ${event.time}` : ''}`,
    event.venue ? `📍 ${event.venue}` : '',
    ...tierLinesFor(custLang),
    codeLineFor(custLang),
    discountLineFor(custLang),
    priceLine,
  ].filter(Boolean).join('\n')).catch(e => console.warn('[events/reserve] customer ping failed:', (e as Error).message))

  let organizerPhone: string | null = null
  if (event.organizer_id) {
    const { data: o } = await supabaseAdmin
      .from('customers').select('phone').eq('id', event.organizer_id).maybeSingle()
    organizerPhone = o?.phone ?? null
  }
  if (!organizerPhone && event.whatsapp) organizerPhone = event.whatsapp

  if (organizerPhone) {
    const orgLang = await getLangByPhone(organizerPhone)
    console.log('[notify] customer phone=%s lang=%s, organizer phone=%s lang=%s',
      custPhone, custLang, organizerPhone, orgLang)
    const orgDateStr = new Date(event.date).toLocaleDateString(orgLang === 'en' ? 'en-GB' : 'fr-FR', {
      day: '2-digit', month: 'long', year: 'numeric',
    })
    const organizerHeader = needsApproval
      ? pickLang(
          `📋 *Nouvelle réservation en attente*\nCode #${primaryCode} — répondez "confirmer reservation ${primaryCode}" ou "rejeter reservation ${primaryCode}".`,
          `📋 *New reservation pending*\nCode #${primaryCode} — reply "confirm reservation ${primaryCode}" or "reject reservation ${primaryCode}".`,
          orgLang,
        )
      : pickLang(`🎟 *Nouvelle réservation* — #${primaryCode}`, `🎟 *New reservation* — #${primaryCode}`, orgLang)
    await sendWhatsApp(organizerPhone, [
      organizerHeader,
      ``,
      `🎉 ${event.title}`,
      `📅 ${orgDateStr}`,
      `👤 ${custName}`,
      `📱 ${custPhone}`,
      ...tierLinesFor(orgLang),
      codeLineFor(orgLang),
      discountLineFor(orgLang),
      finalTotal > 0 ? `💰 ${finalTotal.toLocaleString()} FCFA` : '',
    ].filter(Boolean).join('\n')).catch(e => console.warn('[events/reserve] organizer ping failed:', (e as Error).message))
  }

  return NextResponse.json({
    ok: true,
    reservation_id:    inserted[0].id,
    reservation_ids:   inserted.map(r => r.id),
    reservation_code:  primaryCode,
    reservation_codes: inserted.map(r => r.reservation_code),
    quantity:          totalQuantity,
    original_price:    totalPrice,
    discount_amount:   discountTotal,
    voucher_code:      appliedVoucher?.code ?? null,
    total_price:       finalTotal,
  })
}
