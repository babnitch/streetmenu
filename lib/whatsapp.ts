// Twilio WhatsApp notification service — server-only

const ACCOUNT_SID   = process.env.TWILIO_ACCOUNT_SID!
const API_KEY_SID   = process.env.TWILIO_API_KEY_SID!
const API_KEY_SECRET = process.env.TWILIO_API_KEY_SECRET!
const FROM           = process.env.TWILIO_WHATSAPP_NUMBER ?? 'whatsapp:+14155238886'

// Twilio rejects WhatsApp bodies over 1600 chars (error 21617). We use a
// slightly tighter cap so the suffix added when continuing across parts
// still fits.
const MAX_WHATSAPP_LENGTH = 1500

// ── Core send ─────────────────────────────────────────────────────────────────

export interface SendResult {
  ok:     boolean
  status: number            // Twilio HTTP status (0 on network error)
  sid?:   string            // Twilio message SID when present
  twilioStatus?: string     // Twilio's own status field (queued, accepted, failed…)
  error?: string            // Short error string when ok=false
}

// Low-level single-shot send via Twilio. Does not split; callers that may
// hand in a body longer than 1600 chars should go through sendWhatsApp (or
// the explicit sendLongWhatsApp alias) which chunks first.
async function sendWhatsAppRaw(to: string, message: string): Promise<SendResult> {
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

// Splits a long WhatsApp body into chunks ≤ MAX_WHATSAPP_LENGTH. Prefers
// breaks at double-newline (section boundaries), then single newline, then
// the last space, and finally a hard cut. Exported for tests; production
// callers should use sendWhatsApp / sendLongWhatsApp.
export function splitWhatsAppMessage(message: string, max = MAX_WHATSAPP_LENGTH): string[] {
  if (message.length <= max) return [message]
  const parts: string[] = []
  let remaining = message
  while (remaining.length > max) {
    const slice = remaining.slice(0, max)
    const minSplit = Math.floor(max * 0.5)
    let splitAt = slice.lastIndexOf('\n\n')
    if (splitAt < minSplit) {
      const nl = slice.lastIndexOf('\n')
      if (nl >= minSplit) splitAt = nl
    }
    if (splitAt < minSplit) {
      const sp = slice.lastIndexOf(' ')
      if (sp >= minSplit) splitAt = sp
    }
    if (splitAt < minSplit) splitAt = max
    parts.push(remaining.slice(0, splitAt).trimEnd())
    remaining = remaining.slice(splitAt).replace(/^\s+/, '')
  }
  if (remaining.length > 0) parts.push(remaining)
  return parts
}

// Sends a WhatsApp message via Twilio. Always resolves with a SendResult;
// never throws. Keep callers resilient to individual recipient failures.
//
// Long bodies are split at natural breakpoints so we never hit Twilio's
// 1600-char limit (error 21617). The returned SendResult reflects the last
// chunk — if any earlier chunk failed, we still attempt the rest so the
// recipient at least gets partial output.
//
// IMPORTANT (Twilio sandbox): recipients that have not sent `join <keyword>`
// to the sandbox number receive NOTHING, but Twilio's API still returns
// 201 + an SID. Delivery failures only show up in Twilio's async status
// callback or the Twilio console. At this layer we can detect protocol
// errors (401, 4xx on bad To/From, 429 rate limits, network failures)
// but not post-accept silent drops.
export async function sendWhatsApp(to: string, message: string): Promise<SendResult> {
  if (message.length <= MAX_WHATSAPP_LENGTH) {
    return sendWhatsAppRaw(to, message)
  }
  const parts = splitWhatsAppMessage(message)
  let last: SendResult = { ok: true, status: 0 }
  for (const part of parts) {
    last = await sendWhatsAppRaw(to, part)
  }
  return last
}

// Explicit alias for callers that want to signal "this body might be long."
// Behaviour is identical to sendWhatsApp — both auto-split — but the name
// documents intent at the call site.
export async function sendLongWhatsApp(to: string, message: string): Promise<SendResult> {
  return sendWhatsApp(to, message)
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
  // Pre-formatted bilingual estimate, e.g.
  // "🕐 Temps estimé / Estimated time: 20-35 min". '' (default) when the
  // restaurant hasn't set a range — the line is then omitted entirely.
  prepLine = '',
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
    ...(prepLine ? [``, prepLine] : []),
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
  const id4 = last4(order.id)
  const msg = [
    `✅ Votre commande #${id4} a été confirmée! En attente de préparation.`,
    ``,
    `/ Your order #${id4} has been confirmed! Waiting to be prepared. — ${restaurantName}`,
  ].join('\n')

  await sendWhatsApp(customerPhone, msg)
}

export async function notifyCustomerOrderPreparing(
  customerPhone: string,
  order: OrderPayload,
  restaurantName: string
): Promise<void> {
  const id4 = last4(order.id)
  const msg = [
    `🍳 Votre commande #${id4} est en cours de préparation!`,
    ``,
    `/ Your order #${id4} is being prepared! — ${restaurantName}`,
  ].join('\n')

  await sendWhatsApp(customerPhone, msg)
}

export async function notifyCustomerOrderReady(
  customerPhone: string,
  order: OrderPayload,
  restaurantName: string
): Promise<void> {
  const id4 = last4(order.id)
  const msg = [
    `🎉 Votre commande #${id4} est prête! Venez la récupérer chez ${restaurantName}.`,
    ``,
    `/ Your order #${id4} is ready! Come pick it up at ${restaurantName}.`,
  ].join('\n')

  await sendWhatsApp(customerPhone, msg)
}

export async function notifyCustomerOrderDelivered(
  customerPhone: string,
  order: OrderPayload,
  restaurantName: string
): Promise<void> {
  const id4 = last4(order.id)
  const msg = [
    `✅ Commande #${id4} récupérée. Merci et bon appétit!`,
    ``,
    `/ Order #${id4} picked up. Thank you and enjoy! — ${restaurantName}`,
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
    `❌ Votre commande #${id4} a été annulée par *${restaurantName}*.`,
    ``,
    `/ Your order #${id4} has been cancelled by *${restaurantName}*.`,
    ``,
    `Envoyez "commander" pour passer une nouvelle commande.`,
    `Send "commander" to place a new order.`,
  ].join('\n')

  await sendWhatsApp(customerPhone, msg)
}
