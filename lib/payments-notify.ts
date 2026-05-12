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
import { sendWhatsApp } from '@/lib/whatsapp'
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

  // ── Customer confirmation ──────────────────────────────────────────────────
  if (order.customer_phone) {
    console.log(`[payment] sending customer confirmation: order=${order.id} to=${order.customer_phone}`)
    try {
      await sendWhatsApp(order.customer_phone, [
        `✅ *Paiement confirmé! / Payment confirmed!*`,
        ``,
        `🧾 Commande #${id4}`,
        `🏪 ${restName}`,
        `💰 ${total.toLocaleString()} FCFA`,
        ``,
        `Votre commande est confirmée et le restaurant prépare votre repas.`,
        `Your order is confirmed and the restaurant is preparing your meal.`,
      ].join('\n'))
    } catch (e) {
      console.error('[payment] customer confirmation failed:', (e as Error).message)
    }
  } else {
    console.warn(`[payment] notifyPaidOrder: order ${order.id} has no customer_phone — skipping customer ping`)
  }

  // ── Vendor fan-out ─────────────────────────────────────────────────────────
  const recipients = await vendorRecipients(order.restaurant_id)
  console.log(`[payment] sending vendor notification: order=${order.id} restaurant=${order.restaurant_id} recipients=${JSON.stringify(recipients)}`)
  if (recipients.length === 0) {
    console.warn(`[payment] notifyPaidOrder: no vendor recipients for restaurant ${order.restaurant_id}`)
    return
  }

  const mno = correspondent ? mnoLabel(correspondent) : 'mobile money'
  const msg = [
    `💰 *PAIEMENT REÇU / PAYMENT RECEIVED*`,
    ``,
    `🧾 Commande #${id4}`,
    `👤 ${order.customer_name}`,
    `📱 ${order.customer_phone}`,
    `💳 ${mno}`,
    `💰 ${total.toLocaleString()} FCFA`,
    ``,
    `La commande est payée — préparez-la! / Order is paid — prepare it!`,
    `Répondez "ok ${id4}" pour confirmer / Reply "ok ${id4}" to confirm`,
  ].join('\n')

  const results = await Promise.allSettled(recipients.map(p => sendWhatsApp(p, msg)))
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.error(`[payment] vendor notify rejected to=${recipients[i]} reason=${String(r.reason)}`)
    }
  })
}
