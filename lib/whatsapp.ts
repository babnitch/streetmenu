// Twilio WhatsApp notification service — server-only

const ACCOUNT_SID   = process.env.TWILIO_ACCOUNT_SID!
const API_KEY_SID   = process.env.TWILIO_API_KEY_SID!
const API_KEY_SECRET = process.env.TWILIO_API_KEY_SECRET!
const FROM           = process.env.TWILIO_WHATSAPP_NUMBER ?? 'whatsapp:+14155238886'

// ── Core send ─────────────────────────────────────────────────────────────────

export async function sendWhatsApp(to: string, message: string): Promise<void> {
  // Normalise destination: accept bare numbers or whatsapp: prefixed
  const destination = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`

  const url = `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`
  const body = new URLSearchParams({ From: FROM, To: destination, Body: message })

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${API_KEY_SID}:${API_KEY_SECRET}`).toString('base64')}`,
    },
    body: body.toString(),
  })

  if (!res.ok) {
    const err = await res.text()
    console.error('[whatsapp] send failed:', res.status, err)
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

export async function notifyVendorNewOrder(
  vendorWhatsapp: string,
  order: OrderPayload,
  restaurantName: string
): Promise<void> {
  const time = new Date(order.created_at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
  const itemLines = Array.isArray(order.items)
    ? order.items.map((i: OrderItem) => `  • ${i.quantity}× ${i.name} — ${Number(i.price).toLocaleString()} FCFA`).join('\n')
    : ''

  const msg = [
    `🛒 *Nouvelle commande / New Order* — ${restaurantName}`,
    `🕐 ${time}`,
    ``,
    `*Client / Customer:* ${order.customer_name}`,
    `*Tél / Phone:* ${order.customer_phone}`,
    ``,
    `*Articles / Items:*`,
    itemLines,
    ``,
    `*Total: ${Number(order.total_price).toLocaleString()} FCFA*`,
    ``,
    `Répondez "commandes" pour voir toutes vos commandes.`,
    `Reply "orders" to see all your orders.`,
  ].join('\n')

  await sendWhatsApp(vendorWhatsapp, msg)
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
