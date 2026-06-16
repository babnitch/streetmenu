// Twilio WhatsApp notification service — server-only

const ACCOUNT_SID   = process.env.TWILIO_ACCOUNT_SID!
const API_KEY_SID   = process.env.TWILIO_API_KEY_SID!
const API_KEY_SECRET = process.env.TWILIO_API_KEY_SECRET!
const FROM           = process.env.TWILIO_WHATSAPP_NUMBER ?? 'whatsapp:+14155238886'

// Twilio rejects WhatsApp bodies over 1600 chars (error 21617). We use a
// slightly tighter cap so the suffix added when continuing across parts
// still fits.
const MAX_WHATSAPP_LENGTH = 1500

// ── Language preference ──────────────────────────────────────────────────────
// Customers see notifications in one language at a time. 'fr' is the
// global default — the majority of users are in francophone West Africa.
// Lookup is intentionally lazy + cached-free; the column is small and on
// the customer row we usually already fetched for routing.
export type Lang = 'fr' | 'en'

export const DEFAULT_LANG: Lang = 'fr'

// Picks the right localised string. Pass both versions inline at the call
// site — keeps the translation visible next to the surrounding code and
// avoids a sprawl of id → string lookup tables.
export function pickLang(fr: string, en: string, lang: Lang | null | undefined): string {
  return lang === 'en' ? en : fr
}

// Convenience normaliser for things read out of the DB (column may be null
// for legacy rows that predate the column).
export function normalizeLang(value: string | null | undefined): Lang {
  return value === 'en' ? 'en' : 'fr'
}

// Lazy lookup of a customer's preferred_language by phone number — used by
// notifier helpers that only have the recipient phone (not the customer
// row) at hand. Falls back to DEFAULT_LANG when the row isn't found or the
// column is null. Imports supabaseAdmin locally to keep lib/whatsapp.ts's
// surface narrow when it's used from edge contexts.
export async function getLangByPhone(phone: string | null | undefined): Promise<Lang> {
  if (!phone) return DEFAULT_LANG
  const { supabaseAdmin } = await import('@/lib/supabaseAdmin')
  const { data } = await supabaseAdmin
    .from('customers')
    .select('preferred_language')
    .eq('phone', phone)
    .maybeSingle()
  return normalizeLang(data?.preferred_language)
}

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
//
// `prepLine` is a pre-formatted single-language estimate (callers localise
// it via prepTimeLine in lib/whatsapp/ordering.ts). Empty string when the
// restaurant hasn't set a range.
export async function notifyCustomerOrderPlaced(
  customerPhone: string,
  order: OrderPayload,
  restaurantName: string,
  trackingUrl: string,
  prepLine = '',
  lang: Lang = DEFAULT_LANG,
): Promise<void> {
  const id4 = last4(order.id)
  const items = Array.isArray(order.items) ? order.items : []
  const itemsLabel = pickLang('Articles', 'Items', lang)
  const itemBullet = lang === 'en' ? '  • ' : '  • '
  const itemLines = items.map(i => `${itemBullet}${i.quantity}× ${i.name} — ${Number(i.price).toLocaleString()} FCFA`).join('\n')

  const msg = [
    pickLang(`✅ *Commande confirmée!*`, `✅ *Order confirmed!*`, lang),
    ``,
    pickLang(`🧾 Commande #${id4}`, `🧾 Order #${id4}`, lang),
    `🏪 ${restaurantName}`,
    ``,
    `🍽️ *${itemsLabel}:*`,
    itemLines,
    ``,
    `💰 *Total: ${Number(order.total_price).toLocaleString()} FCFA*`,
    ...(prepLine ? [``, prepLine] : []),
    ``,
    pickLang(
      `Le restaurant a été notifié et prépare votre commande!`,
      `The restaurant has been notified and is preparing your order!`,
      lang,
    ),
    ``,
    pickLang(`Suivez votre commande ici:`, `Track your order here:`, lang),
    trackingUrl,
  ].join('\n')

  await sendWhatsApp(customerPhone, msg)
}

export async function notifyCustomerOrderConfirmed(
  customerPhone: string,
  order: OrderPayload,
  restaurantName: string,
  lang: Lang = DEFAULT_LANG,
): Promise<void> {
  const id4 = last4(order.id)
  const msg = pickLang(
    `✅ Votre commande #${id4} a été confirmée! En attente de préparation. — ${restaurantName}`,
    `✅ Your order #${id4} has been confirmed! Waiting to be prepared. — ${restaurantName}`,
    lang,
  )
  await sendWhatsApp(customerPhone, msg)
}

export async function notifyCustomerOrderPreparing(
  customerPhone: string,
  order: OrderPayload,
  restaurantName: string,
  lang: Lang = DEFAULT_LANG,
): Promise<void> {
  const id4 = last4(order.id)
  const msg = pickLang(
    `🍳 Votre commande #${id4} est en cours de préparation! — ${restaurantName}`,
    `🍳 Your order #${id4} is being prepared! — ${restaurantName}`,
    lang,
  )
  await sendWhatsApp(customerPhone, msg)
}

export async function notifyCustomerOrderReady(
  customerPhone: string,
  order: OrderPayload,
  restaurantName: string,
  lang: Lang = DEFAULT_LANG,
): Promise<void> {
  const id4 = last4(order.id)
  const msg = pickLang(
    `🎉 Votre commande #${id4} est prête! Venez la récupérer chez ${restaurantName}.`,
    `🎉 Your order #${id4} is ready! Come pick it up at ${restaurantName}.`,
    lang,
  )
  await sendWhatsApp(customerPhone, msg)
}

export async function notifyCustomerOrderDelivered(
  customerPhone: string,
  order: OrderPayload,
  restaurantName: string,
  lang: Lang = DEFAULT_LANG,
): Promise<void> {
  const id4 = last4(order.id)
  const msg = pickLang(
    `✅ Commande #${id4} récupérée. Merci et bon appétit! — ${restaurantName}`,
    `✅ Order #${id4} picked up. Thank you and enjoy! — ${restaurantName}`,
    lang,
  )
  await sendWhatsApp(customerPhone, msg)
}

export async function notifyCustomerOrderCancelled(
  customerPhone: string,
  order: OrderPayload,
  restaurantName: string,
  lang: Lang = DEFAULT_LANG,
): Promise<void> {
  const id4 = last4(order.id)
  const msg = pickLang(
    `❌ Votre commande #${id4} a été annulée par *${restaurantName}*.\n\nEnvoyez "commander" pour passer une nouvelle commande.`,
    `❌ Your order #${id4} has been cancelled by *${restaurantName}*.\n\nSend "commander" to place a new order.`,
    lang,
  )
  await sendWhatsApp(customerPhone, msg)
}
