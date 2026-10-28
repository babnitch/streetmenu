// Paid-order WhatsApp notifications.
//
// Called from two paths — the PawaPay webhook (/api/payments/webhook) and
// the client polling endpoint (/api/payments/status/[depositId]). Both
// guard on payment_status BEFORE flipping the row to 'paid', so this helper
// runs at most once per order and double-firing PawaPay callbacks don't
// double-notify customers or vendors.
//
// Awaits every send so Vercel can't cut the fetch short — the caller's
// response stays open until both messages land at Twilio.

import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { sendWhatsApp, getLangByPhone, pickLang, type Lang } from '@/lib/whatsapp'
import { vendorRecipients, prepTimeLine, deliveryInfoFromOrder, deliveryLines } from '@/lib/whatsapp/ordering'
import { notifyOrganizer } from '@/lib/eventRecipients'
import { mnoLabel, type PawaPayCorrespondent } from '@/lib/pawapay'
import { EVENT_DATE_COLUMNS, formatEventDates, formatEventWhen, formatEventDay, isMultiDay } from '@/lib/eventDate'

export async function notifyPaidOrder(
  orderId: string,
  correspondent?: PawaPayCorrespondent,
): Promise<void> {
  const { data: order } = await supabaseAdmin
    .from('orders')
    .select('id, restaurant_id, customer_phone, customer_name, total_price, items, fulfilment, delivery_fee, delivery_address, delivery_landmark, delivery_phone')
    .eq('id', orderId)
    .maybeSingle()
  if (!order) {
    console.warn(`[payment] notifyPaidOrder: order ${orderId} not found`)
    return
  }

  const { data: restaurant } = await supabaseAdmin
    .from('restaurants')
    .select('name')
    .eq('id', order.restaurant_id)
    .maybeSingle()
  const restName = restaurant?.name ?? '—'
  const id4 = order.id.replace(/-/g, '').slice(-4).toUpperCase()
  const total = Number(order.total_price)
  // Paid orders get ONE message per side, so it carries the item list too
  // (the web page no longer calls /api/whatsapp/notify-order after paying).
  const items = (Array.isArray(order.items) ? order.items : []) as Array<{ name: string; quantity: number; price: number }>
  const itemLines = items.map(i => `  • ${i.quantity}× ${i.name} — ${(Number(i.quantity) * Number(i.price)).toLocaleString()} FCFA`)
  const itemsBlock = (lang: Lang) => itemLines.length
    ? [``, pickLang(`🍽️ *Articles:*`, `🍽️ *Items:*`, lang), ...itemLines]
    : []

  console.log(`[payment] calling notifyPaidOrder for order: ${order.id} restaurant=${order.restaurant_id}`)

  // ── Customer confirmation ──────────────────────────────────────────────────
  if (order.customer_phone) {
    console.log(`[payment] sending customer confirmation: order=${order.id} to=${order.customer_phone}`)
    const lang = await getLangByPhone(order.customer_phone)
    const prepLine = await prepTimeLine(order.restaurant_id, '🕐', lang, order.fulfilment)
    const r = await sendWhatsApp(order.customer_phone, [
      pickLang(`✅ *Paiement confirmé!*`, `✅ *Payment confirmed!*`, lang),
      ``,
      pickLang(`🧾 Commande #${id4}`, `🧾 Order #${id4}`, lang),
      `🏪 ${restName}`,
      ...itemsBlock(lang),
      ``,
      pickLang(`💰 *Total payé: ${total.toLocaleString()} FCFA*`, `💰 *Total paid: ${total.toLocaleString()} FCFA*`, lang),
      ...(prepLine ? [prepLine] : []),
      ``,
      pickLang(
        `Votre commande est confirmée et le restaurant prépare votre repas.`,
        `Your order is confirmed and the restaurant is preparing your meal.`,
        lang,
      ),
    ].join('\n'), { context: 'payment_confirmation', relatedId: order.id })
    console.log(`[payment] customer notification result: ok=${r.ok} httpStatus=${r.status} sid=${r.sid ?? '-'} twilioStatus=${r.twilioStatus ?? '-'}${r.error ? ` error=${r.error.slice(0, 200)}` : ''}`)
  } else {
    console.warn(`[payment] notifyPaidOrder: order ${order.id} has no customer_phone — skipping customer ping`)
  }

  // ── Vendor fan-out ─────────────────────────────────────────────────────────
  const recipients = await vendorRecipients(order.restaurant_id)
  console.log(`[payment] sending vendor notification: order=${order.id} restaurant=${order.restaurant_id} recipients=${JSON.stringify(recipients)}`)
  if (recipients.length === 0) {
    console.warn(`[payment] notifyPaidOrder: no vendor recipients for restaurant ${order.restaurant_id}. Check restaurants.whatsapp and active owner/manager rows in restaurant_team.`)
    return
  }

  const mno = correspondent ? mnoLabel(correspondent) : 'mobile money'
  const delivery = deliveryInfoFromOrder(order)

  const results = await Promise.allSettled(recipients.map(async p => {
    const lang = await getLangByPhone(p)
    const msg = [
      pickLang(`🔔 *NOUVELLE COMMANDE — PAYÉE*`, `🔔 *NEW ORDER — PAID*`, lang),
      ``,
      pickLang(`🧾 Commande #${id4}`, `🧾 Order #${id4}`, lang),
      `👤 ${order.customer_name}`,
      `📱 ${order.customer_phone}`,
      ...itemsBlock(lang),
      ...deliveryLines(delivery, lang),
      ``,
      `💳 ${mno}`,
      pickLang(`💰 *Total payé: ${total.toLocaleString()} FCFA*`, `💰 *Total paid: ${total.toLocaleString()} FCFA*`, lang),
      ``,
      pickLang(`La commande est payée — préparez-la!`, `Order is paid — prepare it!`, lang),
      pickLang(`Répondez "ok ${id4}" pour confirmer`, `Reply "ok ${id4}" to confirm`, lang),
    ].join('\n')
    return sendWhatsApp(p, msg, { context: 'payment_confirmation', relatedId: order.id })
  }))
  results.forEach((r, i) => {
    const to = recipients[i]
    if (r.status === 'rejected') {
      console.error(`[payment] vendor notification result: ok=false to=${to} reason=${String(r.reason)}`)
    } else {
      const v = r.value
      console.log(`[payment] vendor notification result: ok=${v.ok} to=${to} httpStatus=${v.status} sid=${v.sid ?? '-'} twilioStatus=${v.twilioStatus ?? '-'}${v.error ? ` error=${v.error.slice(0, 200)}` : ''}`)
    }
  })
}

// Sibling helper for paid event reservations. Same guard pattern as
// notifyPaidOrder: the caller flips payment_status to 'paid' under a
// pending guard before calling us, so duplicate webhook + poll firings
// don't double-notify.
//
// Customer gets a ticket confirmation; organizer (organizer_id customer
// if present, else events.whatsapp) gets a "ticket sold" ping.
export async function notifyPaidReservation(
  reservationId: string,
  correspondent?: PawaPayCorrespondent,
): Promise<void> {
  const { data: r } = await supabaseAdmin
    .from('event_reservations')
    .select('id, event_id, event_date, customer_name, customer_phone, quantity, total_price, reservation_code')
    .eq('id', reservationId)
    .maybeSingle()
  if (!r) {
    console.warn(`[payment] notifyPaidReservation: reservation ${reservationId} not found`)
    return
  }
  const { data: event } = await supabaseAdmin
    .from('events')
    .select(`id, title, ${EVENT_DATE_COLUMNS}, venue, whatsapp, organizer_id`)
    .eq('id', r.event_id)
    .maybeSingle()
  if (!event) {
    console.warn(`[payment] notifyPaidReservation: event ${r.event_id} not found`)
    return
  }

  const total   = Number(r.total_price ?? 0)
  const id4     = r.reservation_code ?? r.id.replace(/-/g, '').slice(-4).toUpperCase()
  // Format the date in each recipient's language (customer vs organizer). A
  // multi-day ticket is for one day: name that day, not the whole range.
  const bookedDay = isMultiDay(event) && r.event_date ? String(r.event_date) : null
  const fmtDate = (l: Lang) => bookedDay ? formatEventDay(bookedDay, l, 'message') : formatEventDates(event, l, 'message')
  const fmtWhen = (l: Lang) => bookedDay
    ? formatEventDay(bookedDay, l, 'message') + (event.time ? ` · ${event.time}` : '')
    : formatEventWhen(event, l, 'message')
  const mno = correspondent ? mnoLabel(correspondent) : 'mobile money'

  console.log(`[payment] calling notifyPaidReservation for reservation: ${r.id} event=${event.id}`)

  // ── Customer ticket ────────────────────────────────────────────────────────
  if (r.customer_phone) {
    console.log(`[payment] sending reservation customer confirmation: reservation=${r.id} to=${r.customer_phone}`)
    const lang = await getLangByPhone(r.customer_phone)
    const sent = await sendWhatsApp(r.customer_phone, [
      pickLang(`🎟 *Réservation payée!*`, `🎟 *Reservation paid!*`, lang),
      ``,
      `🎉 ${event.title}`,
      `📅 ${fmtWhen(lang)}`,
      event.venue ? `📍 ${event.venue}` : '',
      pickLang(
        `🎟 ${r.quantity} place(s)`,
        `🎟 ${r.quantity} ticket(s)`,
        lang,
      ),
      pickLang(`🎫 Code de réservation: *#${id4}*`, `🎫 Reservation code: *#${id4}*`, lang),
      `💰 ${total.toLocaleString()} FCFA · ${mno}`,
      ``,
      pickLang(`À bientôt!`, `See you soon!`, lang),
    ].filter(Boolean).join('\n'), { context: 'payment_confirmation', relatedId: r.id })
    console.log(`[payment] reservation customer result: ok=${sent.ok} sid=${sent.sid ?? '-'} twilioStatus=${sent.twilioStatus ?? '-'}${sent.error ? ` error=${sent.error.slice(0, 200)}` : ''}`)
  } else {
    console.warn(`[payment] notifyPaidReservation: reservation ${r.id} has no customer_phone`)
  }

  // ── Organizer ping ─────────────────────────────────────────────────────────
  // The organiser's account phone (else events.whatsapp) plus the event's
  // extra notification number — lib/eventRecipients.ts.
  const sentOrg = await notifyOrganizer(event, orgLang => [
    pickLang(`💰 *PAIEMENT REÇU*`, `💰 *PAYMENT RECEIVED*`, orgLang),
    ``,
    pickLang(`🎟 Réservation #${id4}`, `🎟 Reservation #${id4}`, orgLang),
    `🎉 ${event.title}`,
    `📅 ${fmtDate(orgLang)}`,
    `👤 ${r.customer_name}`,
    `📱 ${r.customer_phone}`,
    pickLang(`🎟 ${r.quantity} place(s)`, `🎟 ${r.quantity} ticket(s)`, orgLang),
    `💳 ${mno}`,
    `💰 ${total.toLocaleString()} FCFA`,
  ].join('\n'), { context: 'payment_confirmation', relatedId: r.id })
  if (sentOrg === 0) console.warn(`[payment] notifyPaidReservation: no organizer message accepted for event ${event.id}`)
}
