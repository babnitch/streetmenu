// Twilio WhatsApp notification service — server-only

const ACCOUNT_SID   = process.env.TWILIO_ACCOUNT_SID!
const API_KEY_SID   = process.env.TWILIO_API_KEY_SID!
const API_KEY_SECRET = process.env.TWILIO_API_KEY_SECRET!
const FROM           = process.env.TWILIO_WHATSAPP_NUMBER ?? 'whatsapp:+14155238886'

// ── Core send ─────────────────────────────────────────────────────────────────

export interface SendResult {
  ok:     boolean
  status: number            // Twilio HTTP status (0 on network error)
  sid?:   string            // Twilio message SID when present
  twilioStatus?: string     // Twilio's own status field (queued, accepted, failed…)
  error?: string            // Short error string when ok=false
}

// Sends a WhatsApp message via Twilio. Always resolves with a SendResult;
// never throws. Keep callers resilient to individual recipient failures.
//
// IMPORTANT (Twilio sandbox): recipients that have not sent `join <keyword>`
// to the sandbox number receive NOTHING, but Twilio's API still returns
// 201 + an SID. Delivery failures only show up in Twilio's async status
// callback or the Twilio console. At this layer we can detect protocol
// errors (401, 4xx on bad To/From, 429 rate limits, network failures)
// but not post-accept silent drops.
export async function sendWhatsApp(to: string, message: string): Promise<SendResult> {
  const destination = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`
  const url = `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`
  const body = new URLSearchParams({ From: FROM, To: destination, Body: message })

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${API_KEY_SID}:${API_KEY_SECRET}`).toString('base64')}`,
      },
      body: body.toString(),
    })
    const text = await res.text()
    if (!res.ok) {
      console.error(`[whatsapp] send FAILED to=${destination} status=${res.status} body=${text.slice(0, 400)}`)
      return { ok: false, status: res.status, error: text.slice(0, 400) }
    }
    try {
      const parsed = JSON.parse(text) as { sid?: string; status?: string }
      console.log(`[whatsapp] send ok to=${destination} sid=${parsed.sid ?? '-'} twilioStatus=${parsed.status ?? '-'}`)
      return { ok: true, status: res.status, sid: parsed.sid, twilioStatus: parsed.status }
    } catch {
      console.log(`[whatsapp] send ok to=${destination} (no JSON body)`)
      return { ok: true, status: res.status }
    }
  } catch (e) {
    const msg = (e as Error).message
    console.error(`[whatsapp] send THREW to=${destination}: ${msg}`)
    return { ok: false, status: 0, error: msg }
  }
}

// ── Notification templates ────────────────────────────────────────────────────

interface OrderItem { name: string; quantity: number; price: number }

interface OrderPayload {
  id: string
  customer_name: string
  customer_phone: string
  items: OrderItem[]
  total_price: number
  created_at: string
}

function last4(orderId: string): string {
  return orderId.replace(/-/g, '').slice(-4).toUpperCase()
}

// Sent to a customer right after their web order is inserted, before the
// vendor has accepted/prepared anything. "Placed" distinguishes it from
// notifyCustomerOrderConfirmed, which fires when the vendor sends "ok XXXX".
export async function notifyCustomerOrderPlaced(
  customerPhone: string,
  order: OrderPayload,
  restaurantName: string,
  trackingUrl: string,
): Promise<void> {
  const id4 = last4(order.id)
  const items = Array.isArray(order.items) ? order.items : []
  const itemLines = items.map(i => `  • ${i.quantity}× ${i.name} — ${Number(i.price).toLocaleString()} FCFA`).join('\n')

  const msg = [
    `✅ *Commande confirmée / Order confirmed!*`,
    ``,
    `🧾 Commande #${id4}`,
    `🏪 ${restaurantName}`,
    ``,
    `🍽️ *Articles / Items:*`,
    itemLines,
    ``,
    `💰 *Total: ${Number(order.total_price).toLocaleString()} FCFA*`,
    ``,
    `Le restaurant a été notifié et prépare votre commande!`,
    `The restaurant has been notified and is preparing your order!`,
    ``,
    `Suivez votre commande ici / Track your order here:`,
    trackingUrl,
  ].join('\n')

  await sendWhatsApp(customerPhone, msg)
}

export async function notifyCustomerOrderConfirmed(
  customerPhone: string,
  order: OrderPayload,
  restaurantName: string
): Promise<void> {
  const msg = [
    `✅ *Commande confirmée / Order Confirmed*`,
    ``,
    `Bonjour ${order.customer_name} ! Votre commande chez *${restaurantName}* est confirmée.`,
    `Hi ${order.customer_name}! Your order at *${restaurantName}* is confirmed.`,
    ``,
    `*Total: ${Number(order.total_price).toLocaleString()} FCFA*`,
    ``,
    `Nous vous préviendrons quand elle sera prête. / We'll let you know when it's ready.`,
  ].join('\n')

  await sendWhatsApp(customerPhone, msg)
}

export async function notifyCustomerOrderReady(
  customerPhone: string,
  order: OrderPayload,
  restaurantName: string
): Promise<void> {
  const msg = [
    `🍽️ *Commande prête / Order Ready*`,
    ``,
    `Bonjour ${order.customer_name} ! Votre commande chez *${restaurantName}* est prête à être récupérée.`,
    `Hi ${order.customer_name}! Your order at *${restaurantName}* is ready for pickup.`,
    ``,
    `*Total: ${Number(order.total_price).toLocaleString()} FCFA*`,
  ].join('\n')

  await sendWhatsApp(customerPhone, msg)
}

export async function notifyCustomerOrderCancelled(
  customerPhone: string,
  order: OrderPayload,
  restaurantName: string
): Promise<void> {
  const id4 = last4(order.id)
  const msg = [
    `❌ *Commande annulée / Order Cancelled*`,
    ``,
    `Bonjour ${order.customer_name},`,
    `Votre commande #${id4} chez *${restaurantName}* a été annulée par le restaurant.`,
    `Your order #${id4} at *${restaurantName}* has been cancelled by the restaurant.`,
    ``,
    `Envoyez "commander" pour passer une nouvelle commande.`,
    `Send "commander" to place a new order.`,
  ].join('\n')

  await sendWhatsApp(customerPhone, msg)
}
