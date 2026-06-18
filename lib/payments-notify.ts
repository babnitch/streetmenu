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
import { sendWhatsApp, getLangByPhone, pickLang } from '@/lib/whatsapp'
import { vendorRecipients } from '@/lib/whatsapp/ordering'
import { mnoLabel, type PawaPayCorrespondent } from '@/lib/pawapay'

export async function notifyPaidOrder(
  orderId: string,
  correspondent?: PawaPayCorrespondent,
): Promise<void> {
  const { data: order } = await supabaseAdmin
    .from('orders')
    .select('id, restaurant_id, customer_phone, customer_name, total_price')
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

  console.log(`[payment] calling notifyPaidOrder for order: ${order.id} restaurant=${order.restaurant_id}`)

  // ── Customer confirmation ──────────────────────────────────────────────────
  if (order.customer_phone) {
    console.log(`[payment] sending customer confirmation: order=${order.id} to=${order.customer_phone}`)
    const lang = await getLangByPhone(order.customer_phone)
    const r = await sendWhatsApp(order.customer_phone, [
      pickLang(`✅ *Paiement confirmé!*`, `✅ *Payment confirmed!*`, lang),
      ``,
      pickLang(`🧾 Commande #${id4}`, `🧾 Order #${id4}`, lang),
      `🏪 ${restName}`,
      `💰 ${total.toLocaleString()} FCFA`,
      ``,
      pickLang(
        `Votre commande est confirmée et le restaurant prépare votre repas.`,
        `Your order is confirmed and the restaurant is preparing your meal.`,
        lang,
      ),
    ].join('\n'))
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

  const results = await Promise.allSettled(recipients.map(async p => {
    const lang = await getLangByPhone(p)
    const msg = [
      pickLang(`💰 *PAIEMENT REÇU*`, `💰 *PAYMENT RECEIVED*`, lang),
      ``,
      pickLang(`🧾 Commande #${id4}`, `🧾 Order #${id4}`, lang),
      `👤 ${order.customer_name}`,
      `📱 ${order.customer_phone}`,
      `💳 ${mno}`,
      `💰 ${total.toLocaleString()} FCFA`,
      ``,
      pickLang(`La commande est payée — préparez-la!`, `Order is paid — prepare it!`, lang),
      pickLang(`Répondez "ok ${id4}" pour confirmer`, `Reply "ok ${id4}" to confirm`, lang),
    ].join('\n')
    return sendWhatsApp(p, msg)
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
    .select('id, event_id, customer_name, customer_phone, quantity, total_price')
    .eq('id', reservationId)
    .maybeSingle()
  if (!r) {
    console.warn(`[payment] notifyPaidReservation: reservation ${reservationId} not found`)
    return
  }
  const { data: event } = await supabaseAdmin
    .from('events')
    .select('id, title, date, time, venue, whatsapp, organizer_id')
    .eq('id', r.event_id)
    .maybeSingle()
  if (!event) {
    console.warn(`[payment] notifyPaidReservation: event ${r.event_id} not found`)
    return
  }

  const total   = Number(r.total_price ?? 0)
  const id4     = r.id.replace(/-/g, '').slice(-4).toUpperCase()
  const dateStr = new Date(event.date).toLocaleDateString('fr-FR', {
    day: '2-digit', month: 'long', year: 'numeric',
  })
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
      `📅 ${dateStr}${event.time ? ` · ${event.time}` : ''}`,
      event.venue ? `📍 ${event.venue}` : '',
      pickLang(
        `🎟 ${r.quantity} place(s)`,
        `🎟 ${r.quantity} ticket(s)`,
        lang,
      ),
      `💰 ${total.toLocaleString()} FCFA · ${mno}`,
      ``,
      pickLang(`À bientôt!`, `See you soon!`, lang),
    ].filter(Boolean).join('\n'))
    console.log(`[payment] reservation customer result: ok=${sent.ok} sid=${sent.sid ?? '-'} twilioStatus=${sent.twilioStatus ?? '-'}${sent.error ? ` error=${sent.error.slice(0, 200)}` : ''}`)
  } else {
    console.warn(`[payment] notifyPaidReservation: reservation ${r.id} has no customer_phone`)
  }

  // ── Organizer ping ─────────────────────────────────────────────────────────
  // Organizer customer account wins; fall back to events.whatsapp. Unlike
  // restaurants we don't have a "team" of organizers — a single inbox is
  // the right shape for the way Tchop & Ndjoka runs events today.
  let organizerPhone: string | null = null
  if (event.organizer_id) {
    const { data: o } = await supabaseAdmin
      .from('customers').select('phone').eq('id', event.organizer_id).maybeSingle()
    organizerPhone = o?.phone ?? null
  }
  if (!organizerPhone && event.whatsapp) organizerPhone = event.whatsapp

  if (!organizerPhone) {
    console.warn(`[payment] notifyPaidReservation: no organizer recipient for event ${event.id}`)
    return
  }

  console.log(`[payment] sending reservation organizer notification: event=${event.id} to=${organizerPhone}`)
  const orgLang = await getLangByPhone(organizerPhone)
  const sentOrg = await sendWhatsApp(organizerPhone, [
    pickLang(`💰 *PAIEMENT REÇU*`, `💰 *PAYMENT RECEIVED*`, orgLang),
    ``,
    pickLang(`🎟 Réservation #${id4}`, `🎟 Reservation #${id4}`, orgLang),
    `🎉 ${event.title}`,
    `📅 ${dateStr}`,
    `👤 ${r.customer_name}`,
    `📱 ${r.customer_phone}`,
    pickLang(`🎟 ${r.quantity} place(s)`, `🎟 ${r.quantity} ticket(s)`, orgLang),
    `💳 ${mno}`,
    `💰 ${total.toLocaleString()} FCFA`,
  ].join('\n'))
  console.log(`[payment] reservation organizer result: ok=${sentOrg.ok} sid=${sentOrg.sid ?? '-'} twilioStatus=${sentOrg.twilioStatus ?? '-'}${sentOrg.error ? ` error=${sentOrg.error.slice(0, 200)}` : ''}`)
}
