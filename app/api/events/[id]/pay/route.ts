import { NextRequest, NextResponse } from 'next/server'
import { requireSideOn } from '@/lib/platformSwitch'
import { requireEventModule } from '@/lib/modulesServer'
import { bookingLinkLine } from '@/lib/siteLinks'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { notifyOrganizer } from '@/lib/eventRecipients'
import { getSessionFromRequest } from '@/lib/auth'
import { isEventOrganizer } from '@/lib/eventAuth'
import { writeAudit } from '@/lib/audit'
import { createDeposit, detectMNO, mnoLabel, countryFromCity } from '@/lib/pawapay'
import { tierAvailability, hasActiveTiers, totalMismatch, PICK_TIER_ERROR, PRICE_CHANGED_BOOKING_TEXT, type TicketTier } from '@/lib/tiers'
import { canPayOnline, normalizeMode, modeFromLegacy } from '@/lib/paymentMode'
import { generateReservationCode } from '@/lib/reservationCode'
import { validateVoucher, consumeVoucherForReservation } from '@/lib/vouchers'
import { sendWhatsApp, getLangByPhone, pickLang, normalizeLang, type Lang } from '@/lib/whatsapp'
import { isPastEvent, PAST_EVENT_ERROR, EVENT_DATE_COLUMNS, formatEventWhen, formatEventDates, formatEventDay, isMultiDay, resolveBookingDay } from '@/lib/eventDate'
import { reserveEventSeats, type SeatRequestRow } from '@/lib/eventSeats'
import { depositFailure } from '@/lib/whatsapp/ordering'
import { randomUUID } from 'crypto'
import { samePhone } from '@/lib/phone'
import { formatFCFA } from '@/lib/money'

export const dynamic = 'force-dynamic'

// POST /api/events/[id]/pay
// Body: { quantity, phoneNumber, tier_id?, event_date?, voucher_code?, locale? }
//
// Mirrors /api/payments/initiate for restaurant orders. Books a pending
// event_reservation through reserve_event_seats (per-day, per-tier capacity,
// atomic — lib/eventSeats.ts) with the deposit id already on it, then calls
// PawaPay createDeposit and returns the depositId for client-side polling.
// event_date is required for a multi-day event.
//
// Webhook + status poll in /api/payments/{webhook,status/[depositId]}
// are responsible for flipping payment_status to 'paid' and firing the
// notifyPaidReservation fan-out.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {

  // M6: platform switch — events off → 503 platform_off.
  const platformOff = await requireSideOn('events')
  if (platformOff) return platformOff
  // Same login gate as /reserve — paying for a ticket is a booking, so it
  // needs an account. Viewing the event stays public.
  const session = getSessionFromRequest(req)
  if (!session || session.role !== 'customer') {
    console.log('[events/pay] rejected — no customer session (role=%s)', session?.role ?? 'anonymous')
    return NextResponse.json({
      error:          'Connectez-vous pour réserver / Log in to reserve',
      login_required: true,
    }, { status: 401 })
  }
  const customerId = session.id

  const body = await req.json().catch(() => ({}))
  const quantityRaw = Number(body.quantity)
  const quantity = Number.isFinite(quantityRaw) && quantityRaw >= 1 && quantityRaw <= 10
    ? Math.floor(quantityRaw)
    : 1
  const phoneNumber = typeof body.phoneNumber === 'string' ? body.phoneNumber.trim() : ''
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
    .select(`id, title, ${EVENT_DATE_COLUMNS}, venue, city, whatsapp, organizer_id, submitted_by, is_active, event_status, ticket_price, max_tickets, tickets_sold, payment_mode, payment_enabled, commission_rate, reservations_open`)
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
  // M4: paid tickets need Réservations + Billets payants.
  const payOff = await requireEventModule(event, 'reservations') ?? await requireEventModule(event, 'paid_tickets')
  if (payOff) return payOff
  // Same past-event gate as /reserve — a finished event can't sell tickets.
  if (isPastEvent(event)) {
    console.log('[events/pay] rejected — event %s is past (date=%s end_date=%s)', event.id, event.date, event.end_date)
    return NextResponse.json({ error: PAST_EVENT_ERROR }, { status: 409 })
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
    // Lifecycle only (sales window, active). Capacity for the chosen day is
    // checked atomically by reserve_event_seats below.
    const avail = tierAvailability(tier)
    if (avail.kind !== 'active') {
      return NextResponse.json({
        error: `Tarif non disponible / Tier not available`,
        state: avail.kind,
      }, { status: 409 })
    }
  } else if (await hasActiveTiers(event.id)) {
    // Once tiers exist they set the price; the event's ticket_price may be 0.
    return NextResponse.json({ error: PICK_TIER_ERROR, reason: 'tier_required' }, { status: 400 })
  }

  const ticketPrice = tier ? tier.price : (Number(event.ticket_price ?? 0) || 0)
  if (ticketPrice <= 0) {
    return NextResponse.json({
      error: 'Prix du billet invalide / Invalid ticket price',
    }, { status: 400 })
  }

  // Which day — required for a multi-day event.
  const day = resolveBookingDay(event, body.event_date)
  if (!day) {
    return NextResponse.json({ error: 'Choisissez un jour de l\'événement / Pick a day of the event' }, { status: 400 })
  }

  // Identity always comes from the session's account row. Same shape as
  // /reserve — no guest name/phone from the body.
  const { data: c } = await supabaseAdmin
    .from('customers').select('name, phone, preferred_language').eq('id', customerId).maybeSingle()
  const custName  = c?.name  ?? ''
  const custPhone = c?.phone ?? ''
  let storedLang: Lang | null = c ? normalizeLang(c.preferred_language) : null
  if (!custName || !custPhone) {
    return NextResponse.json({
      error: 'Profil incomplet — ajoutez un nom et un téléphone / Incomplete profile — add a name and phone',
    }, { status: 400 })
  }

  // Organizers can't buy tickets to their own event — same rule as /reserve,
  // by account id first then by phone (covers the not-logged-in organizer).
  let organizerPhone: string | null = null
  if (event.organizer_id) {
    const { data: o } = await supabaseAdmin
      .from('customers').select('phone').eq('id', event.organizer_id).maybeSingle()
    organizerPhone = o?.phone ?? null
  }
  if (!organizerPhone && event.whatsapp) organizerPhone = event.whatsapp
  const selfById    = isEventOrganizer(event, customerId)
  const selfByPhone = samePhone(custPhone, organizerPhone)
  if (selfById || selfByPhone) {
    console.log('[events/pay] rejected self-booking on event=%s (byId=%s byPhone=%s)', event.id, selfById, selfByPhone)
    return NextResponse.json({
      error: 'Vous ne pouvez pas réserver votre propre événement / You cannot book your own event',
    }, { status: 403 })
  }

  // Sync the site locale onto the account before the deposit starts: the paid
  // confirmation is sent later by the PawaPay webhook (notifyPaidReservation),
  // which only has the phone to go on — so the stored preference has to be
  // right by then or the customer gets the wrong language.
  const requestLocale: Lang | null =
    body.locale === 'en' ? 'en' : body.locale === 'fr' ? 'fr' : null
  if (requestLocale && requestLocale !== storedLang) {
    await supabaseAdmin
      .from('customers').update({ preferred_language: requestLocale }).eq('id', customerId)
    console.log('[events/pay] synced customer=%s preferred_language → %s', customerId, requestLocale)
    storedLang = requestLocale
  }

  const country = countryFromCity(event.city)
  const mno     = detectMNO(phoneNumber, country ?? undefined)
  if (!mno) {
    return NextResponse.json({ error: 'Numéro non supporté / Unsupported phone number' }, { status: 400 })
  }

  const totalPrice = ticketPrice * quantity
  const commissionRate = Number(event.commission_rate ?? 0.10) || 0.10

  // ── Promo code / voucher ───────────────────────────────────────────────────
  // Validated against THIS event; discount reduces the charged amount and
  // commission is recomputed off the discounted total.
  const voucherInput = typeof body.voucher_code === 'string' ? body.voucher_code.trim() : ''
  let appliedVoucher: { id: string; code: string } | null = null
  let discountAmount = 0
  if (voucherInput && totalPrice > 0) {
    const vres = await validateVoucher(voucherInput, { customerId, eventId: event.id, orderTotal: totalPrice })
    if (!vres.ok) {
      return NextResponse.json({ error: vres.message, voucher_rejected: vres.reason }, { status: 422 })
    }
    appliedVoucher = { id: vres.voucher.id, code: vres.voucher.code }
    discountAmount = vres.discount
  }
  const finalTotal = Math.max(0, totalPrice - discountAmount)
  if (totalMismatch(body.expected_total, finalTotal)) {
    console.warn('[events/pay] price mismatch event=%s: page=%s server=%d', event.id, body.expected_total, finalTotal)
    return NextResponse.json({ error: PRICE_CHANGED_BOOKING_TEXT, reason: 'price_mismatch', total_price: finalTotal }, { status: 409 })
  }
  const commissionAmount = finalTotal > 0 ? Math.round(finalTotal * commissionRate) : 0

  // A 100%-off voucher makes the ticket free — PawaPay can't take a 0 deposit,
  // so confirm it as a free reservation and skip the payment step entirely.
  if (finalTotal <= 0) {
    const freeCode = await generateReservationCode()
    const freeBooked = await reserveEventSeats(event.id, day, [{
      customer_id: customerId, customer_name: custName, customer_phone: custPhone,
      quantity, total_price: 0, commission_amount: 0,
      discount_amount: discountAmount, voucher_code: appliedVoucher?.code ?? null,
      payment_status: 'not_required', reservation_status: 'confirmed', reservation_code: freeCode,
      tier_id: tier?.id ?? null, tier_name: tier?.name ?? null, tier_price: tier?.price ?? null,
    }])
    if (!freeBooked.ok) return NextResponse.json(freeBooked.body, { status: freeBooked.status })
    const freeRes = freeBooked.rows[0]
    if (appliedVoucher) {
      try { await consumeVoucherForReservation(appliedVoucher.id, customerId) }
      catch (e) { console.error('[events/pay] voucher error:', (e as Error).message) }
    }
    console.log('[events/pay] voucher %s → free reservation (-%d FCFA)', appliedVoucher?.code, discountAmount)

    // Confirm to the customer — unlike the paid path, no deposit webhook will
    // fire, so this branch must send the confirmation itself.
    if (custPhone) {
      // Customer's language, in the same priority order as /reserve: site
      // locale sent with the request → account preference → phone lookup.
      const lang: Lang = requestLocale ?? storedLang ?? await getLangByPhone(custPhone)
      console.log('[events/pay] customer lang=%s (locale=%s stored=%s)', lang, requestLocale ?? '-', storedLang ?? '-')
      const whenStr = isMultiDay(event)
        ? formatEventDay(day, lang, 'message') + (event.time ? ` · ${event.time}` : '')
        : formatEventWhen(event, lang, 'message')
      console.log('[reserve] sending WhatsApp to customer:', custPhone)
      await sendWhatsApp(custPhone, [
        pickLang(`✅ *Réservation confirmée!*`, `✅ *Reservation confirmed!*`, lang),
        ``,
        `🎉 ${event.title}`,
        `📅 ${whenStr}`,
        event.venue ? `📍 ${event.venue}` : '',
        pickLang(`🎟 ${quantity} place(s)`, `🎟 ${quantity} ticket(s)`, lang),
        pickLang(`🎫 Code de réservation: *#${freeRes.reservation_code}*`, `🎫 Reservation code: *#${freeRes.reservation_code}*`, lang),
        appliedVoucher ? pickLang(`🎫 Code ${appliedVoucher.code}: -${formatFCFA(discountAmount)} (gratuit!)`, `🎫 Code ${appliedVoucher.code}: -${formatFCFA(discountAmount)} (free!)`, lang) : '',
        bookingLinkLine(lang),
      ].filter(Boolean).join('\n'), { context: 'event_reservation', relatedId: event.id })
        .then(r => console.log('[reserve] WhatsApp result:', r?.ok ? 'ok' : `failed (${r?.error ?? r?.status ?? 'unknown'})`))
        .catch(e => console.warn('[reserve] WhatsApp error:', (e as Error).message))
    }

    // The organiser hears about it too (account phone + extra number) —
    // this booking never reaches the payment webhook that normally tells them.
    await notifyOrganizer(event, orgLang => [
      pickLang(`🎟 *Nouvelle réservation* — #${freeRes.reservation_code}`, `🎟 *New reservation* — #${freeRes.reservation_code}`, orgLang),
      ``,
      `🎉 ${event.title}`,
      `📅 ${isMultiDay(event) ? formatEventDay(day, orgLang, 'message') : formatEventDates(event, orgLang, 'message')}`,
      `👤 ${custName}`,
      `📱 ${custPhone}`,
      pickLang(`🎟 ${quantity} place(s)`, `🎟 ${quantity} ticket(s)`, orgLang),
      appliedVoucher ? `🎫 ${appliedVoucher.code}: -${formatFCFA(discountAmount)}` : '',
    ].filter(Boolean).join('\n'), { context: 'event_reservation', relatedId: event.id }, organizerPhone)

    return NextResponse.json({
      ok: true, reservation_id: freeRes.id, reservation_code: freeRes.reservation_code, event_date: day,
      free_after_discount: true, original_price: totalPrice, discount_amount: discountAmount, total_price: 0,
    })
  }

  // Pending reservation FIRST, booked through reserve_event_seats (per-day
  // capacity, atomic) with the deposit id already on it: a callback that
  // beats our own write — or a request that times out after PawaPay created
  // the deposit — still finds this row.
  const reservationCode = await generateReservationCode()
  const depositId = randomUUID()
  const seatRow: SeatRequestRow = {
    customer_id:        customerId,
    customer_name:      custName,
    customer_phone:     custPhone,
    quantity,
    total_price:        finalTotal,
    commission_amount:  commissionAmount,
    discount_amount:    discountAmount,
    voucher_code:       appliedVoucher?.code ?? null,
    payment_status:     'pending',
    payment_id:         depositId,
    payment_method:     mno.correspondent,
    reservation_status: 'confirmed',
    reservation_code:   reservationCode,
    tier_id:            tier?.id    ?? null,
    tier_name:          tier?.name  ?? null,
    tier_price:         tier?.price ?? null,
  }
  const booked = await reserveEventSeats(event.id, day, [seatRow])
  if (!booked.ok) {
    console.log('[events/pay] refused event=%s day=%s: %s', event.id, day, booked.body.error)
    return NextResponse.json(booked.body, { status: booked.status })
  }
  const reservation = booked.rows[0]
  console.log('[events/pay] reservation=%s event=%s day=%s qty=%d deposit=%s', reservation.id, event.id, day, quantity, depositId)

  let depositResult
  try {
    depositResult = await createDeposit({
      amount:      finalTotal,
      currency:    mno.currency,
      phoneNumber,
      orderId:     reservation.id,
      description: `${event.title} ${reservation.id.slice(0, 6)}`,
      depositId,
    })
  } catch (e) {
    const msg = (e as Error).message
    const f = depositFailure(e)
    console.error('[events/pay] createDeposit failed reservation=%s definitive=%s: %s', reservation.id, f.definitive, msg)
    if (f.definitive) {
      // No prompt will appear: settle as failed so the seats go back now
      // (no failure WhatsApp on this path — the page shows the error).
      const { settleDeposit } = await import('@/lib/payments-settle')
      await settleDeposit(depositId, { status: 'REJECTED', failureReason: f.reason }, 'status_poll')
    }
    // Otherwise the outcome is unknown: the reservation keeps its deposit id
    // and the webhook or reconcile settles it; its hold lapses on its own.
    return NextResponse.json({ error: msg }, { status: 502 })
  }

  // Consume the voucher now that payment is under way — mirrors the restaurant
  // order flow (consume at creation, not at settlement).
  if (appliedVoucher) {
    await consumeVoucherForReservation(appliedVoucher.id, customerId)
    console.log('[events/pay] voucher %s applied: -%d FCFA (%d → %d)', appliedVoucher.code, discountAmount, totalPrice, finalTotal)
  }

  await writeAudit({
    action:          'event_payment_initiated',
    targetType:      'event_reservation',
    targetId:        reservation.id,
    performedBy:     customerId,
    performedByType: 'customer',
    metadata: {
      event_id:      event.id,
      deposit_id:    depositResult.depositId,
      correspondent: depositResult.correspondent,
      amount:        finalTotal,
      original_price: totalPrice,
      voucher_code:  appliedVoucher?.code ?? null,
      discount_amount: discountAmount,
      currency:      mno.currency,
      quantity,
    },
  })

  return NextResponse.json({
    ok:               true,
    reservation_id:   reservation.id,
    reservation_code: reservation.reservation_code,
    event_date:       day,
    depositId:        depositResult.depositId,
    status:         depositResult.status,
    mno:            depositResult.correspondent,
    mnoLabel:       mnoLabel(depositResult.correspondent),
    currency:       mno.currency,
    amount:         finalTotal,
    original_price: totalPrice,
    discount_amount: discountAmount,
    voucher_code:   appliedVoucher?.code ?? null,
  })
}
