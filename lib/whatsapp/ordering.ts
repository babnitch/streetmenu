// WhatsApp ordering flow — customer-side state machine + vendor order actions.
// See docs/superpowers/specs/2026-04-18-whatsapp-ordering-design.md

import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { writeAudit } from '@/lib/audit'
import {
  sendWhatsApp,
  notifyCustomerOrderConfirmed,
  notifyCustomerOrderPreparing,
  notifyCustomerOrderReady,
  notifyCustomerOrderDelivered,
  notifyCustomerOrderCancelled,
} from '@/lib/whatsapp'
import { validateVoucher, consumeVoucherForOrder, isPercentDiscount } from '@/lib/vouchers'
import { createDeposit, detectMNO, countryFromCity } from '@/lib/pawapay'
import { formatPrepTime } from '@/lib/prepTime'

// Reads the restaurant's estimated prep range and formats a bilingual
// WhatsApp line like "🕐 Temps estimé / Estimated time: 20-35 min", or ''
// when the vendor hasn't set one. The leading emoji is caller-supplied so
// the vendor ping can use ⏱️ while customer messages use 🕐. Shared so
// both sides stay consistent.
export async function prepTimeLine(
  restaurantId: string,
  emoji = '🕐',
): Promise<string> {
  const { data } = await supabaseAdmin
    .from('restaurants')
    .select('prep_time_min, prep_time_max')
    .eq('id', restaurantId)
    .maybeSingle()
  const label = formatPrepTime(data?.prep_time_min, data?.prep_time_max)
  return label ? `${emoji} Temps estimé / Estimated time: ${label}` : ''
}

// ── TwiML ack ────────────────────────────────────────────────────────────────
const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>'
function ok(): NextResponse {
  return new NextResponse(EMPTY_TWIML, { status: 200, headers: { 'Content-Type': 'text/xml' } })
}

function sessionExpiry(minutes = 30): string {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString()
}

function last4(orderId: string): string {
  return orderId.replace(/-/g, '').slice(-4).toUpperCase()
}

// ── Types ────────────────────────────────────────────────────────────────────
export interface OrderingCustomer {
  id: string
  name: string
  phone: string
  city: string
}

interface MenuItemRef { menu_item_id: string; name: string; price: number }
interface CartItem extends MenuItemRef { quantity: number }

interface OrderingSessionData {
  restaurant_id: string
  restaurant_name: string
  menu?: MenuItemRef[]
  items?: CartItem[]
  total?: number
  voucher_id?: string
  voucher_code?: string
  voucher_discount?: number
}

interface OrderingSessionRow {
  phone: string
  user_type: string
  step: number
  data: OrderingSessionData
}

// ── Restaurant list ──────────────────────────────────────────────────────────
async function listRestaurantsForCity(city: string): Promise<Array<{ id: string; name: string; cuisine_type: string; city: string }>> {
  const base = supabaseAdmin.from('restaurants')
    .select('id, name, cuisine_type, city')
    .eq('is_active', true)
    .in('status', ['active', 'approved'])
    .is('deleted_at', null)
    .order('name')
    .limit(20)
  const { data } = await base.eq('city', city)
  if (data && data.length > 0) return data

  const { data: all } = await supabaseAdmin.from('restaurants')
    .select('id, name, cuisine_type, city')
    .eq('is_active', true)
    .in('status', ['active', 'approved'])
    .is('deleted_at', null)
    .order('name')
    .limit(20)
  return all ?? []
}

function buildRestaurantListMessage(restaurants: Array<{ name: string; cuisine_type: string; city?: string }>, scopedToCity: string | null): string {
  const header = scopedToCity
    ? `🍽️ *Restaurants à ${scopedToCity} / Restaurants in ${scopedToCity}:*`
    : `🍽️ *Tous les restaurants / All restaurants:*`
  const lines = restaurants.map((r, i) => `${i + 1}. ${r.name} — ${r.cuisine_type}`)
  return [
    header,
    '',
    lines.join('\n'),
    '',
    `Envoyez le numéro du restaurant / Send the restaurant number`,
    `_Envoyez "annuler" pour annuler / Send "cancel" to cancel_`,
  ].join('\n')
}

// ── Menu snapshot ────────────────────────────────────────────────────────────
async function loadAvailableMenu(restaurantId: string): Promise<MenuItemRef[]> {
  const { data } = await supabaseAdmin
    .from('menu_items')
    .select('id, name, price')
    .eq('restaurant_id', restaurantId)
    .eq('is_available', true)
    .order('name')
  return (data ?? []).map(r => ({ menu_item_id: r.id, name: r.name, price: Number(r.price) }))
}

function buildMenuMessage(restaurantName: string, menu: MenuItemRef[]): string {
  if (menu.length === 0) {
    return `🍽️ *${restaurantName}*\n\nMenu vide. / Empty menu.\n\n_Envoyez "annuler" pour choisir un autre restaurant / Send "cancel" to pick another restaurant._`
  }
  const lines = menu.map((m, i) => `${i + 1}. ${m.name} — ${Number(m.price).toLocaleString()} FCFA`)
  return [
    `🍽️ *${restaurantName}*`,
    '',
    lines.join('\n'),
    '',
    `Envoyez votre commande / Send your order:`,
    `_Ex: 1 x2, 3 x1 (2 ${menu[0]?.name ?? 'item'} + 1 ${menu[2]?.name ?? menu[Math.min(1, menu.length - 1)]?.name ?? 'item'})_`,
    `_Envoyez "annuler" pour annuler / Send "cancel" to cancel_`,
  ].join('\n')
}

// ── Order parser ─────────────────────────────────────────────────────────────
export interface ParseOk { ok: true; items: CartItem[]; total: number }
export interface ParseErr { ok: false; error: string }

export function parseOrder(raw: string, menu: MenuItemRef[]): ParseOk | ParseErr {
  const tokens = raw.split(/[,\n]/).map(t => t.trim()).filter(Boolean)
  if (tokens.length === 0) return { ok: false, error: 'Commande vide / Empty order' }

  const merged = new Map<string, CartItem>()

  for (const tok of tokens) {
    const numBased = tok.match(/^(\d+)\s*[x×]\s*(\d+)$/i)
    const nameBased = tok.match(/^(\d+)\s+(.+)$/)

    let menuItem: MenuItemRef | undefined
    let qty = 0

    if (numBased) {
      const idx = parseInt(numBased[1], 10) - 1
      qty = parseInt(numBased[2], 10)
      menuItem = menu[idx]
      if (!menuItem) return { ok: false, error: `Numéro ${idx + 1} invalide / Invalid number` }
    } else if (nameBased) {
      qty = parseInt(nameBased[1], 10)
      const name = nameBased[2].trim().toLowerCase()
      menuItem = menu.find(m => m.name.toLowerCase() === name) ||
                 menu.find(m => m.name.toLowerCase().includes(name))
      if (!menuItem) return { ok: false, error: `"${nameBased[2].trim()}" introuvable / not found` }
    } else {
      return { ok: false, error: `Format non compris: "${tok}" / Not understood. Ex: 1 x2, 3 x1` }
    }

    if (!Number.isFinite(qty) || qty < 1 || qty > 99) {
      return { ok: false, error: `Quantité invalide: ${qty} / Invalid quantity` }
    }

    const key = menuItem.menu_item_id
    const existing = merged.get(key)
    if (existing) {
      existing.quantity += qty
    } else {
      merged.set(key, { ...menuItem, quantity: qty })
    }
  }

  const items = Array.from(merged.values())
  const total = items.reduce((s, i) => s + i.quantity * i.price, 0)
  return { ok: true, items, total }
}

function buildSummaryMessage(restaurantName: string, items: CartItem[], total: number): string {
  const lines = items.map(i => `${i.quantity}× ${i.name} — ${(i.quantity * i.price).toLocaleString()} FCFA`)
  return [
    `📦 *Votre commande / Your order:*`,
    '',
    `🏪 ${restaurantName}`,
    ...lines,
    '',
    `💰 *Total: ${total.toLocaleString()} FCFA*`,
    '',
    `Envoyez "oui" pour confirmer ou "non" pour annuler`,
    `Send "yes" to confirm or "no" to cancel`,
  ].join('\n')
}

// ── Vendor fan-out on order creation ─────────────────────────────────────────
// Exported so web-initiated orders (app/api/whatsapp/notify-order) reuse the
// exact same recipient resolution and message format as WhatsApp-initiated
// orders. Single source of truth for "who gets pinged when an order lands."
export async function vendorRecipients(restaurantId: string): Promise<string[]> {
  const phones = new Set<string>()

  const { data: rest } = await supabaseAdmin
    .from('restaurants').select('whatsapp').eq('id', restaurantId).maybeSingle()
  if (rest?.whatsapp) phones.add(rest.whatsapp)

  const { data: team } = await supabaseAdmin
    .from('restaurant_team')
    .select('role, customers(phone)')
    .eq('restaurant_id', restaurantId)
    .eq('status', 'active')
    .in('role', ['owner', 'manager'])

  for (const m of team ?? []) {
    const c = m.customers as unknown as { phone: string } | null
    if (c?.phone) phones.add(c.phone)
  }
  return Array.from(phones)
}

// Item shape accepted by the notifier. Matches CartItem's relevant subset, so
// the WhatsApp ordering flow passes CartItem[] and the web flow can pass the
// minimal {name, quantity, price} tuples from orders.items JSONB.
export interface OrderNotificationItem {
  name: string
  quantity: number
  price: number
}

export async function notifyVendorsOfNewOrder(
  restaurantId: string,
  restaurantName: string,
  orderId: string,
  customerName: string,
  customerPhone: string,
  items: OrderNotificationItem[],
  total: number,
): Promise<void> {
  const recipients = await vendorRecipients(restaurantId)
  const id4 = last4(orderId)
  console.log(`[ordering] notifyVendors: restaurant=${restaurantId} order=${orderId} recipients=${JSON.stringify(recipients)}`)
  if (recipients.length === 0) {
    console.warn(`[ordering] notifyVendors: NO RECIPIENTS for restaurant=${restaurantId}. Check restaurants.whatsapp and active owner/manager rows in restaurant_team.`)
    return
  }

  const itemLines = items.map(i => `  • ${i.quantity}× ${i.name} (${(i.quantity * i.price).toLocaleString()} FCFA)`).join('\n')
  // ⏱️ for the vendor — a reminder of the window they committed to.
  const prepLine = await prepTimeLine(restaurantId, '⏱️')
  const msg = [
    `🔔 *NOUVELLE COMMANDE / NEW ORDER!*`,
    `━━━━━━━━━━━━━━━━━━`,
    ``,
    `🧾 Commande #${id4}`,
    `🏪 ${restaurantName}`,
    `👤 ${customerName}`,
    `📱 ${customerPhone}`,
    ``,
    `🍽️ *Articles / Items:*`,
    itemLines,
    ``,
    `💰 *Total: ${total.toLocaleString()} FCFA*`,
    ...(prepLine ? [``, prepLine] : []),
    ``,
    `━━━━━━━━━━━━━━━━━━`,
    `Répondez "ok ${id4}" pour confirmer / Reply "ok ${id4}" to confirm`,
    `Répondez "annuler ${id4}" pour annuler / Reply "cancel ${id4}" to cancel`,
  ].join('\n')

  const results = await Promise.allSettled(recipients.map(p => sendWhatsApp(p, msg)))
  results.forEach((r, i) => {
    const to = recipients[i]
    if (r.status === 'rejected') {
      console.error(`[ordering] notifyVendors: send rejected to=${to} reason=${String((r as PromiseRejectedResult).reason)}`)
    } else {
      const v = r.value
      console.log(`[ordering] notifyVendors: to=${to} ok=${v.ok} status=${v.status} sid=${v.sid ?? '-'} twilioStatus=${v.twilioStatus ?? '-'}${v.error ? ` error=${v.error.slice(0, 120)}` : ''}`)
    }
  })
}

// ── Payment helpers ──────────────────────────────────────────────────────────
// Internal: kicks off a PawaPay deposit for a paid_order WhatsApp order and
// tells the customer to confirm on their phone. The caller is expected to
// have already inserted the order row with payment_status='pending'. The
// final success/failure messaging is dispatched by the webhook, which is
// the source of truth for terminal payment status.
async function initiateWhatsappPayment(
  from:           string,
  orderId:        string,
  customerId:     string,
  customerPhone:  string,
  total:          number,
  restaurantName: string,
  restaurantCity: string,
): Promise<boolean> {
  const country = countryFromCity(restaurantCity)
  const mno = detectMNO(customerPhone, country ?? undefined)
  if (!mno) {
    await sendWhatsApp(from,
      `❌ Numéro non supporté pour le paiement mobile.\n` +
      `Phone not supported for mobile payment.`)
    return false
  }

  let result
  try {
    result = await createDeposit({
      amount:      total,
      currency:    mno.currency,
      phoneNumber: customerPhone,
      orderId,
      description: `${restaurantName} ${orderId.slice(0, 6)}`,
    })
  } catch (e) {
    console.error('[ordering] createDeposit failed:', (e as Error).message)
    return false
  }

  await supabaseAdmin
    .from('orders')
    .update({
      payment_id:     result.depositId,
      payment_method: result.correspondent,
      payment_amount: total,
    })
    .eq('id', orderId)

  // Remember the wallet used for the next order's pre-fill. On WhatsApp the
  // customer's account phone is also their MoMo number (Twilio gave us the
  // wallet number for free), so we save it the same way the web flow does.
  await supabaseAdmin
    .from('customers')
    .update({ momo_phone: customerPhone })
    .eq('id', customerId)

  await writeAudit({
    action:     'payment_initiated',
    targetType: 'order',
    targetId:   orderId,
    metadata: {
      deposit_id:    result.depositId,
      correspondent: result.correspondent,
      amount:        total,
      currency:      mno.currency,
      via:           'whatsapp',
    },
  })

  await sendWhatsApp(from, [
    `💰 *Commande de ${total.toLocaleString()} FCFA*`,
    ``,
    `Un prompt de paiement va apparaître sur votre téléphone. Confirmez le paiement avec votre code PIN mobile money.`,
    ``,
    `A payment prompt will appear on your phone. Confirm the payment with your mobile money PIN.`,
    ``,
    `_Si rien n'apparaît dans 30s, envoyez "payer" pour réessayer._`,
    `_If nothing appears in 30s, send "pay" to retry._`,
  ].join('\n'))

  return true
}

// Public: customer typed "payer" / "pay" — find their most recent unpaid
// paid_order and re-trigger a PawaPay deposit. Returns null if no such
// order exists, so the caller can fall through to other intents.
export async function handlePaymentRetry(
  from: string,
  cmd: string,
  customer: OrderingCustomer,
): Promise<NextResponse | null> {
  if (cmd !== 'payer' && cmd !== 'pay') return null

  const { data: order } = await supabaseAdmin
    .from('orders')
    .select('id, restaurant_id, total_price, payment_status, restaurants(name, city)')
    .eq('customer_id', customer.id)
    .eq('order_type', 'paid_order')
    .in('payment_status', ['pending', 'failed'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!order) {
    await sendWhatsApp(from,
      `Aucune commande en attente de paiement. Envoyez "commander" pour en créer une.\n` +
      `No order awaiting payment. Send "commander" to create one.`)
    return ok()
  }

  const rest = order.restaurants as unknown as { name?: string; city?: string } | null
  const initiated = await initiateWhatsappPayment(
    from,
    order.id,
    customer.id,
    customer.phone,
    Number(order.total_price),
    rest?.name ?? '—',
    rest?.city ?? '',
  )
  if (!initiated) {
    await sendWhatsApp(from,
      `⚠️ Paiement indisponible pour le moment. Réessayez plus tard.\n` +
      `Payment unavailable right now. Try again later.`)
  }
  return ok()
}

// ── Public: handle a "commander" / "mes commandes" intent ────────────────────
export async function handleOrderCommand(
  from: string,
  phone: string,
  cmd: string,
  customer: OrderingCustomer,
): Promise<NextResponse | null> {
  if (cmd === 'commander' || cmd === 'order' || cmd === 'commande') {
    const restaurants = await listRestaurantsForCity(customer.city)
    if (restaurants.length === 0) {
      await sendWhatsApp(from, '🚫 Aucun restaurant disponible pour le moment. / No restaurants available right now.')
      return ok()
    }
    const scoped = restaurants.some(r => r.city === customer.city) ? customer.city : null
    const msg = scoped
      ? buildRestaurantListMessage(restaurants, scoped)
      : `Aucun restaurant à ${customer.city}. Voici tous les restaurants / No restaurants in ${customer.city}. Here are all:\n\n` +
        buildRestaurantListMessage(restaurants, null)

    const { error: upsertErr } = await supabaseAdmin.from('signup_sessions').upsert({
      phone,
      user_type: 'ordering',
      step: 1,
      data: { candidates: restaurants.map(r => ({ id: r.id, name: r.name })) } as unknown as Record<string, unknown>,
      expires_at: sessionExpiry(30),
    })
    if (upsertErr) console.error(`[ordering] session upsert failed: ${upsertErr.message}`)
    await sendWhatsApp(from, msg)
    return ok()
  }

  // ── Voucher commands ──────────────────────────────────────────────────────
  if (cmd === 'mes bons' || cmd === 'my vouchers') {
    const { data } = await supabaseAdmin
      .from('customer_vouchers')
      .select('id, used_at, vouchers(id, code, discount_type, discount_value, expires_at, min_order, is_active, restaurant_id, restaurants(name))')
      .eq('customer_id', customer.id)
      .order('claimed_at', { ascending: false })
      .limit(10)

    if (!data || data.length === 0) {
      await sendWhatsApp(from,
        `🎫 Aucun bon. Envoyez "bon CODE" pour en ajouter un (ex: bon BIENVENUE).\n` +
        `No vouchers. Send "voucher CODE" to add one (e.g. voucher BIENVENUE).`)
      return ok()
    }
    const now = Date.now()
    const lines = data.map((cv, i) => {
      const v = cv.vouchers as unknown as {
        id: string; code: string; discount_type: 'percent' | 'fixed'; discount_value: number
        expires_at: string | null; is_active: boolean; restaurants: { name: string } | null
      } | null
      if (!v) return ''
      const value = isPercentDiscount(v.discount_type)
        ? `-${v.discount_value}%`
        : `-${Number(v.discount_value).toLocaleString()} FCFA`
      const used    = !!cv.used_at
      const expired = v.expires_at ? new Date(v.expires_at).getTime() < now : false
      const status  = used ? '✅ Utilisé / Used'
                    : expired ? '⏰ Expiré / Expired'
                    : !v.is_active ? '⚪ Inactif / Inactive'
                    : '🟢 Disponible / Available'
      const scope = v.restaurants?.name ? ` · ${v.restaurants.name}` : ''
      return `${i + 1}. *${v.code}* ${value}${scope}\n   ${status}`
    }).filter(Boolean)

    await sendWhatsApp(from, `🎫 *Vos bons / Your vouchers:*\n\n${lines.join('\n\n')}`)
    return ok()
  }

  // bon CODE / voucher CODE — claim a code into the customer's wallet.
  // Shape mirrors /api/customer/vouchers/claim so a successful claim makes
  // the code immediately usable both on the web and via WhatsApp ordering.
  const claimMatch = cmd.match(/^(?:bon|voucher)\s+([a-z0-9_-]+)$/i)
  if (claimMatch) {
    const code = claimMatch[1].toUpperCase()
    const { data: v } = await supabaseAdmin
      .from('vouchers')
      .select('id, code, discount_type, discount_value, expires_at, is_active, max_uses, current_uses, per_customer_max')
      .eq('code', code).maybeSingle()
    if (!v) {
      await sendWhatsApp(from, `❌ Code introuvable / Code not found: ${code}`)
      return ok()
    }
    if (!v.is_active) {
      await sendWhatsApp(from, `❌ Code désactivé / Code deactivated`)
      return ok()
    }
    if (v.expires_at && new Date(v.expires_at).getTime() < Date.now()) {
      await sendWhatsApp(from, `❌ Code expiré / Code expired`)
      return ok()
    }
    if (v.max_uses != null && v.max_uses > 0 && (v.current_uses ?? 0) >= v.max_uses) {
      await sendWhatsApp(from, `❌ Code épuisé / Code fully used`)
      return ok()
    }
    const { data: prior } = await supabaseAdmin
      .from('customer_vouchers').select('id')
      .eq('customer_id', customer.id).eq('voucher_id', v.id)
    const limit = (v.per_customer_max ?? 1)
    if (limit > 0 && (prior?.length ?? 0) >= limit) {
      await sendWhatsApp(from, `Déjà réclamé / Already claimed: ${code}`)
      return ok()
    }
    const { data: inserted, error: insErr } = await supabaseAdmin
      .from('customer_vouchers').insert({ customer_id: customer.id, voucher_id: v.id })
      .select('id').single()
    if (insErr) {
      console.error('[whatsapp] voucher claim failed:', insErr.message)
      await sendWhatsApp(from, `⚠️ Erreur / Error: ${insErr.message}`)
      return ok()
    }
    await writeAudit({
      action: 'voucher_claimed', targetType: 'voucher', targetId: v.id,
      performedBy: customer.id, performedByType: 'customer',
      metadata: { code, customer_voucher_id: inserted.id, via: 'whatsapp' },
    })
    const value = isPercentDiscount(v.discount_type)
      ? `-${v.discount_value}%`
      : `-${Number(v.discount_value).toLocaleString()} FCFA`
    await sendWhatsApp(from,
      `🎫 Code *${code}* ajouté (${value})!\n` +
      `Voucher *${code}* added (${value})!\n\n` +
      `Utilisez-le à votre prochaine commande. / Use it on your next order.`)
    return ok()
  }

  if (cmd === 'mes commandes' || cmd === 'my orders') {
    const { data } = await supabaseAdmin
      .from('orders')
      .select('id, status, total_price, created_at, order_type, payment_status, restaurants(name)')
      .eq('customer_id', customer.id)
      .order('created_at', { ascending: false })
      .limit(5)

    if (!data || data.length === 0) {
      await sendWhatsApp(from, '📦 Aucune commande. Envoyez "commander" pour en passer une!\n\nNo orders. Send "commander" to place one!')
      return ok()
    }
    const statusLabel: Record<string, string> = {
      pending:    '⏳ En attente / Pending',
      confirmed:  '✅ Confirmée / Confirmed',
      preparing:  '👨‍🍳 En préparation / Preparing',
      ready:      '🎉 Prête / Ready',
      delivered:  '📦 Récupérée / Picked up',
      completed:  '🏁 Terminée / Completed',
      cancelled:  '❌ Annulée / Cancelled',
    }
    const payLabel: Record<string, string> = {
      paid:         '💰 Payé',
      pending:      '⏳ Paiement en attente',
      failed:       '❌ Paiement échoué',
      refunded:     '↩️ Remboursé',
      not_required: '',  // reservations don't need a payment pill
    }
    let hasUnpaid = false
    const lines = data.map((o, i) => {
      const rest = (o.restaurants as unknown as { name: string } | null)?.name ?? '—'
      const label = statusLabel[o.status] ?? o.status
      const pay   = payLabel[o.payment_status ?? 'not_required'] ?? ''
      if (o.order_type === 'paid_order' && (o.payment_status === 'pending' || o.payment_status === 'failed')) {
        hasUnpaid = true
      }
      return `${i + 1}. #${last4(o.id)} - ${rest} - ${Number(o.total_price).toLocaleString()} FCFA - ${label}${pay ? ` - ${pay}` : ''}`
    })
    const tail = hasUnpaid
      ? `\n\n💳 Envoyez "payer" pour réessayer le paiement. / Send "pay" to retry payment.`
      : ''
    await sendWhatsApp(from, `📦 *Vos commandes / Your orders:*\n\n${lines.join('\n')}${tail}`)
    return ok()
  }

  // ── Event reservations ────────────────────────────────────────────────────
  // "mes reservations" / "my reservations" → show upcoming + recent
  // reservations with status + payment pill. Cancellations stay listed so
  // customers can see what they cancelled in WhatsApp scrollback.
  if (cmd === 'mes reservations' || cmd === 'mes réservations' || cmd === 'my reservations') {
    const { data } = await supabaseAdmin
      .from('event_reservations')
      .select('id, quantity, total_price, payment_status, reservation_status, created_at, events(id, title, date, venue, event_status)')
      .eq('customer_id', customer.id)
      .order('created_at', { ascending: false })
      .limit(10)

    if (!data || data.length === 0) {
      await sendWhatsApp(from,
        `🎟 Aucune réservation. Envoyez "evenements" pour parcourir.\n` +
        `No reservations. Send "events" to browse.`)
      return ok()
    }
    const statusLabel: Record<string, string> = {
      confirmed: '✅ Confirmée / Confirmed',
      cancelled: '❌ Annulée / Cancelled',
      attended:  '🎉 Participée / Attended',
    }
    const payLabel: Record<string, string> = {
      paid:         '💰 Payé',
      pending:      '⏳ Paiement en attente',
      failed:       '❌ Paiement échoué',
      not_required: '📋 Gratuit',
    }
    const lines = data.map((r, i) => {
      const ev = r.events as unknown as { title: string; date: string; venue: string | null } | null
      const dateStr = ev?.date
        ? new Date(ev.date).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' })
        : ''
      const pay   = payLabel[r.payment_status ?? 'not_required'] ?? ''
      const stat  = statusLabel[r.reservation_status] ?? r.reservation_status
      return `${i + 1}. *${ev?.title ?? '—'}* (${dateStr})\n   🎟 ${r.quantity} place(s)${r.total_price > 0 ? ` · ${Number(r.total_price).toLocaleString()} FCFA` : ''}\n   ${stat}${pay ? ` · ${pay}` : ''}`
    })

    // Seed a reservations_browse session so "annuler reservation N" can
    // resolve the list number back to the right id without a follow-up
    // round-trip. 15-minute TTL — same as the spec.
    await supabaseAdmin.from('signup_sessions').upsert({
      phone, user_type: 'reservations_browse', step: 1,
      data: { reservation_ids: data.map(d => d.id) },
      expires_at: sessionExpiry(15),
    })

    await sendWhatsApp(from,
      `🎟 *Vos réservations / Your reservations:*\n\n${lines.join('\n\n')}\n\n` +
      `Envoyez "annuler reservation N" pour annuler / Send "cancel reservation N" to cancel`)
    return ok()
  }

  // "annuler reservation N" / "cancel reservation N" — resolves N to the
  // id stored in the most-recent "mes reservations" listing.
  const cancelResvMatch = cmd.match(/^(?:annuler|cancel)\s+(?:reservation|réservation)\s+(\d+)$/i)
  if (cancelResvMatch) {
    const n = parseInt(cancelResvMatch[1], 10)
    const { data: sess } = await supabaseAdmin
      .from('signup_sessions').select('data')
      .eq('phone', phone).eq('user_type', 'reservations_browse')
      .gt('expires_at', new Date().toISOString())
      .maybeSingle()
    const ids = (sess?.data as { reservation_ids?: string[] } | undefined)?.reservation_ids ?? []
    if (!ids.length || n < 1 || n > ids.length) {
      await sendWhatsApp(from,
        `❌ Aucune réservation #${n}. Envoyez "mes reservations" d'abord.\n` +
        `No reservation #${n}. Send "my reservations" first.`)
      return ok()
    }
    const resvId = ids[n - 1]
    // Server-route call would be cleaner but we're already in the same
    // process with service-role access. Inline the cancel logic so the
    // organizer ping reuses sendWhatsApp.
    const { data: r } = await supabaseAdmin
      .from('event_reservations')
      .select('id, event_id, customer_id, customer_name, customer_phone, quantity, payment_status, reservation_status, total_price')
      .eq('id', resvId).maybeSingle()
    if (!r || r.customer_id !== customer.id) {
      await sendWhatsApp(from, `❌ Réservation introuvable / Reservation not found.`)
      return ok()
    }
    if (r.reservation_status === 'cancelled') {
      await sendWhatsApp(from, `Déjà annulée. / Already cancelled.`)
      return ok()
    }
    const { data: ev } = await supabaseAdmin
      .from('events').select('id, title, date, organizer_id, whatsapp, tickets_sold').eq('id', r.event_id).maybeSingle()
    if (!ev) {
      await sendWhatsApp(from, `❌ Événement introuvable / Event not found.`)
      return ok()
    }
    const sold = Number(ev.tickets_sold ?? 0)
    await Promise.all([
      supabaseAdmin.from('event_reservations')
        .update({ reservation_status: 'cancelled', updated_at: new Date().toISOString() })
        .eq('id', r.id),
      supabaseAdmin.from('events')
        .update({ tickets_sold: Math.max(0, sold - Number(r.quantity ?? 0)) })
        .eq('id', ev.id),
    ])
    await writeAudit({
      action:          'event_reservation_cancelled',
      targetType:      'event_reservation',
      targetId:        r.id,
      performedBy:     customer.id,
      performedByType: 'customer',
      previousData:    { reservation_status: r.reservation_status, payment_status: r.payment_status },
      metadata:        { event_id: ev.id, quantity: r.quantity, needs_refund: r.payment_status === 'paid', via: 'whatsapp' },
    })

    const refundLine = r.payment_status === 'paid'
      ? `\n⚠️ Cette réservation a été payée. Contactez l'organisateur pour un remboursement.\n` +
        `This reservation was paid. Contact the organizer for a refund.`
      : ''
    await sendWhatsApp(from, `✅ Réservation annulée. / Reservation cancelled.${refundLine}`)

    // Organizer ping — reuse the customer-cancel pathway from the API.
    let organizerPhone: string | null = null
    if (ev.organizer_id) {
      const { data: o } = await supabaseAdmin.from('customers').select('phone').eq('id', ev.organizer_id).maybeSingle()
      organizerPhone = o?.phone ?? null
    }
    if (!organizerPhone && ev.whatsapp) organizerPhone = ev.whatsapp
    if (organizerPhone) {
      const dateStr = new Date(ev.date).toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' })
      await sendWhatsApp(organizerPhone, [
        `❌ *Réservation annulée / Reservation cancelled*`,
        ``,
        `🎉 ${ev.title}`,
        `📅 ${dateStr}`,
        `👤 ${r.customer_name}`,
        `📱 ${r.customer_phone}`,
        `🎟 ${r.quantity} place(s)`,
      ].join('\n')).catch(() => null)
    }
    return ok()
  }

  // ── Event discovery ───────────────────────────────────────────────────────
  // "evenements" / "events" → upcoming events in the customer's city. Seeds
  // an event_browse session so the customer can pick by number.
  if (cmd === 'evenements' || cmd === 'événements' || cmd === 'events') {
    const today = new Date().toISOString().slice(0, 10)
    // Prefer the customer's city; fall back to anywhere if their city has
    // no upcoming events.
    let { data: scoped } = await supabaseAdmin
      .from('events')
      .select('id, title, date, time, ticket_price, payment_enabled, city')
      .eq('is_active', true).eq('city', customer.city)
      .gte('date', today)
      .order('date', { ascending: true }).limit(10)
    let cityScope = customer.city
    if (!scoped || scoped.length === 0) {
      const { data: any } = await supabaseAdmin
        .from('events')
        .select('id, title, date, time, ticket_price, payment_enabled, city')
        .eq('is_active', true)
        .gte('date', today)
        .order('date', { ascending: true }).limit(10)
      scoped = any ?? []
      cityScope = ''
    }
    if (!scoped || scoped.length === 0) {
      await sendWhatsApp(from, `🎉 Aucun événement à venir. / No upcoming events.`)
      return ok()
    }
    const header = cityScope
      ? `🎉 *Événements à ${cityScope} / Events in ${cityScope}:*`
      : `🎉 *Événements à venir / Upcoming events:*`
    const lines = scoped.map((e, i) => {
      const d = new Date(e.date).toLocaleDateString('fr-FR', { weekday: 'short', day: '2-digit', month: 'short' })
      const price = !e.ticket_price || e.ticket_price <= 0
        ? 'Gratuit / Free'
        : `${Number(e.ticket_price).toLocaleString()} FCFA`
      return `${i + 1}. *${e.title}* — ${d}${e.time ? ` · ${e.time}` : ''} — ${price}`
    })

    await supabaseAdmin.from('signup_sessions').upsert({
      phone, user_type: 'event_browse', step: 1,
      data: { event_ids: scoped.map(e => e.id) },
      expires_at: sessionExpiry(15),
    })

    await sendWhatsApp(from,
      `${header}\n\n${lines.join('\n')}\n\n` +
      `Envoyez le numéro pour voir les détails / Send the number for details`)
    return ok()
  }

  // "reservations XXXX" — organizer-side read-only listing by event short
  // code. Mutation flows (mark attended, cancel event) stay on the web /
  // account "Mes événements" tab; this is the WhatsApp-side quick view.
  const reservationsMatch = cmd.match(/^reservations?\s+([0-9a-f]{4})$/i)
  if (reservationsMatch) {
    const code4 = reservationsMatch[1].toLowerCase()
    // Constrain to events the caller organizes.
    const { data: candidates } = await supabaseAdmin
      .from('events').select('id, title, date, organizer_id, whatsapp')
      .eq('organizer_id', customer.id).limit(50)
    const event = (candidates ?? []).find(e => e.id.replace(/-/g, '').toLowerCase().endsWith(code4))
    if (!event) {
      await sendWhatsApp(from, `❌ Événement #${code4.toUpperCase()} introuvable parmi vos événements. / Event not found in your events.`)
      return ok()
    }
    const { data: resvs } = await supabaseAdmin
      .from('event_reservations')
      .select('customer_name, customer_phone, quantity, payment_status, reservation_status')
      .eq('event_id', event.id)
      .order('created_at', { ascending: false })
      .limit(20)
    if (!resvs || resvs.length === 0) {
      await sendWhatsApp(from, `📋 *${event.title}*\n\nAucune réservation pour le moment. / No reservations yet.`)
      return ok()
    }
    const lines = resvs.map((r, i) => {
      const pay = r.payment_status === 'paid' ? '💰 Payé'
        : r.payment_status === 'pending' ? '⏳ En attente'
        : r.payment_status === 'failed' ? '❌ Échec'
        : '📋 Gratuit'
      const stat = r.reservation_status === 'cancelled' ? ' · ❌ Annulée'
        : r.reservation_status === 'attended' ? ' · 🎉 Participée'
        : ''
      return `${i + 1}. ${r.customer_name} — ${r.quantity} place(s) — ${pay}${stat}\n   📱 ${r.customer_phone}`
    })
    await sendWhatsApp(from,
      `📋 *Réservations — ${event.title}:*\n\n${lines.join('\n\n')}\n\n` +
      `Gérez les présences sur le site / Manage attendance on the site:\n${BASE_URL}/account?tab=events`)
    return ok()
  }

  // "tarifs XXXX" / "tiers XXXX" — organizer-only listing of every
  // (active + inactive) ticket tier on one of their events, with the
  // current sold-counts. Mutations live on the web; this is a quick
  // read-only check.
  const tarifsMatch = cmd.match(/^(?:tarifs|tiers)\s+([0-9a-f]{4})$/i)
  if (tarifsMatch) {
    const code4 = tarifsMatch[1].toLowerCase()
    const { data: candidates } = await supabaseAdmin
      .from('events').select('id, title, organizer_id')
      .eq('organizer_id', customer.id).limit(50)
    const event = (candidates ?? []).find(e => e.id.replace(/-/g, '').toLowerCase().endsWith(code4))
    if (!event) {
      await sendWhatsApp(from, `❌ Événement #${code4.toUpperCase()} introuvable. / Event not found.`)
      return ok()
    }
    const { data: tiers } = await supabaseAdmin
      .from('event_ticket_tiers')
      .select('name, price, max_quantity, sold_count, is_active')
      .eq('event_id', event.id)
      .order('sort_order', { ascending: true })
    if (!tiers || tiers.length === 0) {
      await sendWhatsApp(from, `🎫 *${event.title}*\n\nAucun tarif. / No tiers.\nAjoutez-en sur ${BASE_URL}/account.`)
      return ok()
    }
    const lines = tiers.map((t, i) => {
      const cap = t.max_quantity > 0 ? `${t.sold_count}/${t.max_quantity}` : `${t.sold_count}`
      const inactive = t.is_active ? '' : ' (inactif)'
      const priceLine = t.price === 0 ? 'Gratuit' : `${t.price.toLocaleString()} FCFA`
      return `${i + 1}. ${t.name} — ${priceLine} · ${cap} vendus${inactive}`
    })
    await sendWhatsApp(from, `🎫 *Tarifs — ${event.title}:*\n\n${lines.join('\n')}`)
    return ok()
  }

  // "ajouter tarif XXXX name price max" — organizer shortcut to create
  // a new tier from chat. Spaces in the tier name must be replaced with
  // underscores ("Plein_tarif") for the parser to work; the underscore
  // is rewritten to a space before insert.
  const addTarifMatch = cmd.match(/^ajouter\s+tarif\s+([0-9a-f]{4})\s+(\S+)\s+(\d+)(?:\s+(\d+))?$/i)
  if (addTarifMatch) {
    const code4 = addTarifMatch[1].toLowerCase()
    const rawName = addTarifMatch[2].replace(/_+/g, ' ').trim()
    const price = Number.parseInt(addTarifMatch[3], 10)
    const maxQty = addTarifMatch[4] ? Number.parseInt(addTarifMatch[4], 10) : 0

    const { data: candidates } = await supabaseAdmin
      .from('events').select('id, title, organizer_id')
      .eq('organizer_id', customer.id).limit(50)
    const event = (candidates ?? []).find(e => e.id.replace(/-/g, '').toLowerCase().endsWith(code4))
    if (!event) {
      await sendWhatsApp(from, `❌ Événement #${code4.toUpperCase()} introuvable. / Event not found.`)
      return ok()
    }
    if (!rawName || !Number.isFinite(price) || price < 0) {
      await sendWhatsApp(from, `❌ Format: "ajouter tarif XXXX nom prix max" / "ajouter tarif XXXX name price max"`)
      return ok()
    }

    const { data: existingCount } = await supabaseAdmin
      .from('event_ticket_tiers').select('id').eq('event_id', event.id)
    const sortOrder = (existingCount ?? []).length

    const { data: inserted, error } = await supabaseAdmin
      .from('event_ticket_tiers')
      .insert({
        event_id:     event.id,
        name:         rawName,
        price,
        max_quantity: Number.isFinite(maxQty) ? Math.max(0, maxQty) : 0,
        sort_order:   sortOrder,
        is_active:    true,
      })
      .select('id, name')
      .single()
    if (error || !inserted) {
      await sendWhatsApp(from, `❌ Erreur. Réessayez. / Error. Retry.`)
      return ok()
    }

    const { writeAudit } = await import('@/lib/audit')
    await writeAudit({
      action:          'tier_created',
      targetType:      'event',
      targetId:        event.id,
      performedBy:     customer.id,
      performedByType: 'customer',
      metadata:        { tier_id: inserted.id, name: rawName, price, max_quantity: maxQty, via: 'whatsapp' },
    })

    await sendWhatsApp(from,
      `✅ Tarif *${inserted.name}* ajouté à *${event.title}* — ${price.toLocaleString()} FCFA.\n` +
      `Added to your event.`)
    return ok()
  }

  // "fermer reservations XXXX" / "ouvrir reservations XXXX" — organizer
  // toggle for the events.reservations_open gate. Matches the web button
  // in /account → Mes événements; lets the organizer close walk-ins from
  // their phone.
  const reservGateMatch = cmd.match(/^(fermer|ouvrir|close|open)\s+reservations?\s+([0-9a-f]{4})$/i)
  if (reservGateMatch) {
    const verb = reservGateMatch[1].toLowerCase()
    const code4 = reservGateMatch[2].toLowerCase()
    const open = (verb === 'ouvrir' || verb === 'open')
    const { data: candidates } = await supabaseAdmin
      .from('events').select('id, title, reservations_open')
      .eq('organizer_id', customer.id).limit(50)
    const event = (candidates ?? []).find(e => e.id.replace(/-/g, '').toLowerCase().endsWith(code4))
    if (!event) {
      await sendWhatsApp(from, `❌ Événement #${code4.toUpperCase()} introuvable. / Event not found.`)
      return ok()
    }
    await supabaseAdmin.from('events').update({ reservations_open: open }).eq('id', event.id)
    const { writeAudit } = await import('@/lib/audit')
    await writeAudit({
      action:          open ? 'reservations_opened' : 'reservations_closed',
      targetType:      'event',
      targetId:        event.id,
      performedBy:     customer.id,
      performedByType: 'customer',
      previousData:    { reservations_open: event.reservations_open },
      metadata:        { open, via: 'whatsapp' },
    })
    await sendWhatsApp(from,
      open
        ? `🔓 Réservations ouvertes pour *${event.title}*. / Reservations opened.`
        : `🔒 Réservations fermées pour *${event.title}*. / Reservations closed.`)
    return ok()
  }

  // "confirmer reservation XXXX" / "rejeter reservation XXXX" — organizer
  // confirms / rejects a pending reservation by its 4-char ID suffix.
  // Customer notification is handled inside the API handlers via the
  // shared sendWhatsApp helper, so we just delegate over fetch.
  const reservDecisionMatch = cmd.match(/^(confirmer|rejeter|confirm|reject)\s+reservation\s+([0-9a-f]{4})$/i)
  if (reservDecisionMatch) {
    const verb  = reservDecisionMatch[1].toLowerCase()
    const code4 = reservDecisionMatch[2].toLowerCase()
    const action = (verb === 'confirmer' || verb === 'confirm') ? 'confirm' : 'reject'

    // Resolve the reservation by short code, scoped to this organizer.
    const { data: pendings } = await supabaseAdmin
      .from('event_reservations')
      .select('id, event_id, reservation_status, events!inner(organizer_id, title)')
      .eq('events.organizer_id', customer.id)
      .neq('reservation_status', 'cancelled')
      .neq('reservation_status', 'rejected')
      .order('created_at', { ascending: false })
      .limit(100)
    const match = (pendings ?? []).find(r => r.id.replace(/-/g, '').toLowerCase().endsWith(code4))
    if (!match) {
      await sendWhatsApp(from, `❌ Réservation #${code4.toUpperCase()} introuvable. / Reservation not found.`)
      return ok()
    }

    const { writeAudit } = await import('@/lib/audit')
    if (action === 'confirm') {
      await supabaseAdmin
        .from('event_reservations')
        .update({ reservation_status: 'confirmed', updated_at: new Date().toISOString() })
        .eq('id', match.id)
      await writeAudit({
        action:          'reservation_confirmed_by_organizer',
        targetType:      'event_reservation',
        targetId:        match.id,
        performedBy:     customer.id,
        performedByType: 'customer',
        previousData:    { reservation_status: match.reservation_status },
        metadata:        { event_id: match.event_id, via: 'whatsapp' },
      })
      // Notify the customer.
      const { data: r } = await supabaseAdmin
        .from('event_reservations').select('customer_phone, quantity, events(title)').eq('id', match.id).maybeSingle()
      const ev = r?.events as unknown as { title: string } | null
      if (r?.customer_phone) {
        await sendWhatsApp(r.customer_phone,
          `✅ *Votre réservation est confirmée! / Your reservation is confirmed!*\n🎉 ${ev?.title ?? ''}\n🎟 ${r.quantity} place(s)`,
        ).catch(() => null)
      }
      await sendWhatsApp(from, `✅ Réservation #${code4.toUpperCase()} confirmée. / Reservation confirmed.`)
    } else {
      // Reject — also release seats.
      const { data: r } = await supabaseAdmin
        .from('event_reservations').select('quantity, customer_phone, event_id, events(title, tickets_sold)').eq('id', match.id).maybeSingle()
      if (r) {
        const ev = r.events as unknown as { title: string; tickets_sold: number } | null
        const sold = Number(ev?.tickets_sold ?? 0)
        const next = Math.max(0, sold - Number(r.quantity ?? 0))
        await Promise.all([
          supabaseAdmin.from('event_reservations').update({ reservation_status: 'rejected', updated_at: new Date().toISOString() }).eq('id', match.id),
          supabaseAdmin.from('events').update({ tickets_sold: next }).eq('id', match.event_id),
        ])
        await writeAudit({
          action:          'reservation_rejected',
          targetType:      'event_reservation',
          targetId:        match.id,
          performedBy:     customer.id,
          performedByType: 'customer',
          previousData:    { reservation_status: match.reservation_status },
          metadata:        { event_id: match.event_id, via: 'whatsapp' },
        })
        if (r.customer_phone) {
          await sendWhatsApp(r.customer_phone,
            `❌ *Votre réservation a été refusée / Your reservation was declined*\n🎉 ${ev?.title ?? ''}`,
          ).catch(() => null)
        }
      }
      await sendWhatsApp(from, `❌ Réservation #${code4.toUpperCase()} rejetée. / Reservation rejected.`)
    }
    return ok()
  }

  // "reserver XXXX" / "book XXXX" — shortcut for a known short code. Routes
  // into the same multi-step flow as the browse → detail → reserver path so
  // free + paid events take a consistent quantity prompt and (where
  // payment_enabled) PawaPay USSD step.
  const reserveMatch = cmd.match(/^(?:reserver|réserver|book|reserve)\s+([0-9a-f]{4})$/i)
  if (reserveMatch) {
    const code4 = reserveMatch[1].toLowerCase()
    const { data: candidates } = await supabaseAdmin
      .from('events').select('id, title, event_status, is_active, date, reservations_open')
      .eq('is_active', true)
      .gte('date', new Date().toISOString().slice(0, 10))
      .order('date', { ascending: true }).limit(50)
    const event = (candidates ?? []).find(e => e.id.replace(/-/g, '').toLowerCase().endsWith(code4))
    if (!event) {
      await sendWhatsApp(from, `❌ Événement #${code4.toUpperCase()} introuvable. / Event not found.`)
      return ok()
    }
    if (event.reservations_open === false) {
      await sendWhatsApp(from,
        `🔒 Les réservations pour *${event.title}* sont fermées. / Reservations for *${event.title}* are closed.`)
      return ok()
    }
    return startReserveFlow(from, phone, event.id)
  }

  // "noter" / "rate" — when a customer has a recent delivered order, deep
  // link straight to that restaurant's /#rate anchor; otherwise point them
  // to their orders list so they can pick. The page itself enforces the
  // delivered-order requirement, so this command stays a thin shortcut.
  if (cmd === 'noter' || cmd === 'rate') {
    const { data: lastDelivered } = await supabaseAdmin
      .from('orders')
      .select('restaurant_id, restaurants(name)')
      .eq('customer_id', customer.id)
      .in('status', ['delivered', 'completed'])
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (lastDelivered?.restaurant_id) {
      const rest = lastDelivered.restaurants as unknown as { name: string } | null
      await sendWhatsApp(from,
        `⭐ Notez ${rest?.name ?? 'votre dernier restaurant'} ici / Rate ${rest?.name ?? 'your last restaurant'} here:\n` +
        `${BASE_URL}/restaurant/${lastDelivered.restaurant_id}#rate`)
    } else {
      await sendWhatsApp(from,
        `🍽️ Aucune commande livrée pour le moment. Commandez d'abord, puis revenez pour noter.\n` +
        `No delivered orders yet. Order first, then come back to rate.`)
    }
    return ok()
  }

  // "signaler" / "report" — generic entry point for reporting. We can't
  // run the report modal in chat (reason dropdown + free-text doesn't fit
  // a stateless chat surface cleanly), so we deep-link to the customer's
  // recent surfaces. The page-level 🚩 Report button takes them through
  // the modal.
  if (cmd === 'signaler' || cmd === 'report') {
    // Most-recent restaurant order + most-recent event reservation as
    // likely report contexts.
    const [{ data: lastOrder }, { data: lastResv }] = await Promise.all([
      supabaseAdmin
        .from('orders').select('restaurant_id, restaurants(name)')
        .eq('customer_id', customer.id)
        .order('created_at', { ascending: false }).limit(1).maybeSingle(),
      supabaseAdmin
        .from('event_reservations').select('event_id, events(title)')
        .eq('customer_id', customer.id)
        .order('created_at', { ascending: false }).limit(1).maybeSingle(),
    ])
    const lines: string[] = [`🚩 *Signaler un problème / Report an issue*`, '']
    if (lastOrder?.restaurant_id) {
      const r = lastOrder.restaurants as unknown as { name: string } | null
      lines.push(`🏪 ${r?.name ?? 'Restaurant'}: ${BASE_URL}/restaurant/${lastOrder.restaurant_id}`)
    }
    if (lastResv?.event_id) {
      const e = lastResv.events as unknown as { title: string } | null
      lines.push(`🎉 ${e?.title ?? 'Événement'}: ${BASE_URL}/events/${lastResv.event_id}`)
    }
    if (lines.length === 2) {
      lines.push(
        `Ouvrez la page d'un restaurant ou d'un événement et cliquez "🚩 Signaler".\n` +
        `Open a restaurant or event page and click "🚩 Report".`)
    } else {
      lines.push('', `Cliquez "🚩 Signaler" en bas de la page / Click "🚩 Report" at the bottom.`)
    }
    await sendWhatsApp(from, lines.join('\n'))
    return ok()
  }

  // "publier" / "publish" → deep-link to the in-app submission form. The
  // page itself handles the login gate, so we don't need to check trust
  // state here.
  if (cmd === 'publier' || cmd === 'publish') {
    await sendWhatsApp(from,
      `📢 *Publier un événement / Publish an event*\n\n` +
      `Soumettez votre événement ici / Submit your event here:\n` +
      `${BASE_URL}/events/submit`)
    return ok()
  }

  // "mes evenements" / "mes événements" / "my events" → list events the
  // customer has submitted with their current status. Pending events stay
  // visible so the publisher can track admin review.
  if (cmd === 'mes evenements' || cmd === 'mes événements' || cmd === 'my events') {
    const { data } = await supabaseAdmin
      .from('events')
      .select('id, title, date, is_active, auto_approved, event_status')
      .eq('organizer_id', customer.id)
      .order('date', { ascending: false })
      .limit(10)

    if (!data || data.length === 0) {
      await sendWhatsApp(from,
        `📢 Vous n'avez pas encore soumis d'événement.\n` +
        `You haven't submitted an event yet.\n\n` +
        `Envoyez "publier" pour en créer un. / Send "publish" to create one.`)
      return ok()
    }

    // Trust badge for the publisher — gives them a sense of how close they
    // are to auto-approve without forcing a /account roundtrip.
    const { data: trust } = await supabaseAdmin
      .from('customers')
      .select('events_approved_count, event_auto_approve')
      .eq('id', customer.id)
      .maybeSingle()
    const trustLine = trust?.event_auto_approve
      ? `✅ *Éditeur vérifié / Verified publisher* — publication immédiate.`
      : `🛡 ${trust?.events_approved_count ?? 0}/3 approuvés pour la publication automatique / approved for auto-publish.`

    const lines = data.map((e, i) => {
      const dateStr = new Date(e.date).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' })
      const statusLabel = e.event_status === 'cancelled'
        ? '❌ Annulé / Cancelled'
        : !e.is_active
          ? '⏳ En attente d\'approbation / Pending'
          : e.auto_approved
            ? '⚡ Auto-publié / Auto-published'
            : '✅ Publié / Published'
      return `${i + 1}. *${e.title}* (${dateStr})\n   ${statusLabel}`
    })
    await sendWhatsApp(from, `📢 *Vos événements / Your events:*\n\n${trustLine}\n\n${lines.join('\n\n')}`)
    return ok()
  }

  return null
}

// ── Public: continue an in-progress event session ────────────────────────────
// Drives the multi-step event browse + reserve conversational flow:
//   event_browse        — customer just saw the list; "N" → switch to detail
//   event_detail        — viewing one event; "reserver" → start reserve
//   event_reserve s=1   — asked "how many"; "N" → free path inserts,
//                         payment_enabled events ask for MoMo number (s=2)
//   event_reserve s=2   — asked for MoMo number; "237..." → PawaPay deposit
//                         (status polling lives in /api/payments/status)
// "annuler" / "cancel" at any step clears the session and lets the user
// fall back to the customer command dispatcher.
export async function handleEventSession(
  from: string,
  phone: string,
  cmd: string,
  session: { user_type: string; step: number; data: Record<string, unknown> },
  customer: OrderingCustomer,
): Promise<NextResponse> {
  const { user_type, step, data } = session

  if (cmd === 'annuler' || cmd === 'cancel') {
    await supabaseAdmin.from('signup_sessions').delete().eq('phone', phone)
    await sendWhatsApp(from, '❌ Annulé. / Cancelled.')
    return ok()
  }

  // ── event_browse: customer typed a number from the list ──
  if (user_type === 'event_browse') {
    const n = parseInt(cmd, 10)
    const ids = (data?.event_ids as string[] | undefined) ?? []
    if (!Number.isFinite(n) || n < 1 || n > ids.length) {
      await sendWhatsApp(from,
        `Envoyez un numéro entre 1 et ${ids.length}, ou "annuler".\n` +
        `Send a number between 1 and ${ids.length}, or "cancel".`)
      return ok()
    }
    return showEventDetail(from, phone, ids[n - 1])
  }

  // ── event_detail: "reserver" / "back" / arbitrary number for a new pick ──
  if (user_type === 'event_detail') {
    const eventId = data?.event_id as string | undefined
    if (cmd === 'reserver' || cmd === 'réserver' || cmd === 'reserve' || cmd === 'book') {
      if (!eventId) {
        await supabaseAdmin.from('signup_sessions').delete().eq('phone', phone)
        await sendWhatsApp(from, 'Session expirée. Envoyez "evenements". / Session expired. Send "events".')
        return ok()
      }
      return startReserveFlow(from, phone, eventId)
    }
    if (cmd === 'retour' || cmd === 'back') {
      // The previous event_browse ids may have been overwritten; tell the
      // user to re-list rather than re-fetching from a stale state.
      await supabaseAdmin.from('signup_sessions').delete().eq('phone', phone)
      await sendWhatsApp(from, 'Envoyez "evenements" pour la liste. / Send "events" for the list.')
      return ok()
    }
    await sendWhatsApp(from,
      `Envoyez "reserver" pour réserver, "retour" pour la liste, ou "annuler".\n` +
      `Send "reserve" to book, "back" for the list, or "cancel".`)
    return ok()
  }

  // ── event_reserve step 1: quantity ──
  if (user_type === 'event_reserve' && step === 1) {
    const q = parseInt(cmd, 10)
    if (!Number.isFinite(q) || q < 1 || q > 10) {
      await sendWhatsApp(from, `Envoyez un nombre entre 1 et 10, ou "annuler". / Send 1-10, or "cancel".`)
      return ok()
    }
    const eventId       = data?.event_id as string | undefined
    const eventTitle    = (data?.event_name as string) ?? ''
    const ticketPrice   = Number(data?.ticket_price ?? 0)
    const paymentEnabled = !!data?.payment_enabled
    if (!eventId) {
      await supabaseAdmin.from('signup_sessions').delete().eq('phone', phone)
      await sendWhatsApp(from, 'Session expirée. / Session expired.')
      return ok()
    }

    // Re-pull the event to verify capacity at submit time (the user may
    // have been sitting on the prompt while others booked).
    const { data: event } = await supabaseAdmin
      .from('events')
      .select('id, title, date, time, venue, organizer_id, whatsapp, is_active, event_status, ticket_price, max_tickets, tickets_sold, payment_enabled, commission_rate, city')
      .eq('id', eventId).maybeSingle()
    if (!event || !event.is_active || (event.event_status && ['cancelled', 'completed'].includes(event.event_status))) {
      await supabaseAdmin.from('signup_sessions').delete().eq('phone', phone)
      await sendWhatsApp(from, '❌ Événement clôturé. / Event closed.')
      return ok()
    }
    const sold = Number(event.tickets_sold ?? 0)
    if (event.max_tickets && event.max_tickets > 0 && sold + q > event.max_tickets) {
      await supabaseAdmin.from('signup_sessions').delete().eq('phone', phone)
      await sendWhatsApp(from, `❌ Plus que ${Math.max(0, event.max_tickets - sold)} places. / Only ${Math.max(0, event.max_tickets - sold)} spots left.`)
      return ok()
    }

    const totalPrice = ticketPrice * q
    const commissionRate = Number(event.commission_rate ?? 0.10) || 0.10
    const commissionAmount = totalPrice > 0 ? Math.round(totalPrice * commissionRate) : 0

    if (!paymentEnabled) {
      // Free OR pay-at-door — insert the reservation immediately.
      const { data: reservation, error: insErr } = await supabaseAdmin
        .from('event_reservations')
        .insert({
          event_id:           event.id,
          customer_id:        customer.id,
          customer_name:      customer.name,
          customer_phone:     customer.phone,
          quantity:           q,
          total_price:        totalPrice,
          commission_amount:  commissionAmount,
          payment_status:     'not_required',
          reservation_status: 'confirmed',
        })
        .select('id').single()
      if (insErr || !reservation) {
        await sendWhatsApp(from, `⚠️ Erreur. / Error.`)
        return ok()
      }
      await supabaseAdmin.from('events').update({ tickets_sold: sold + q }).eq('id', event.id)
      await writeAudit({
        action:          'event_reservation_created',
        targetType:      'event_reservation',
        targetId:        reservation.id,
        performedBy:     customer.id,
        performedByType: 'customer',
        metadata:        { event_id: event.id, event_title: event.title, quantity: q, total_price: totalPrice, paid: false, via: 'whatsapp' },
      })
      await supabaseAdmin.from('signup_sessions').delete().eq('phone', phone)

      const dateStr = new Date(event.date).toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' })
      const payLine = ticketPrice > 0
        ? `\n💰 Paiement sur place: ${totalPrice.toLocaleString()} FCFA / Pay at the door`
        : ''
      await sendWhatsApp(from, [
        `✅ *Réservation confirmée! / Reservation confirmed!*`,
        ``,
        `🎉 ${event.title}`,
        `📅 ${dateStr}${event.time ? ` · ${event.time}` : ''}`,
        event.venue ? `📍 ${event.venue}` : '',
        `🎟 ${q} place(s)`,
        payLine,
      ].filter(Boolean).join('\n'))

      // Organizer ping.
      await pingOrganizer(event, customer, q, totalPrice, dateStr)
      return ok()
    }

    // Paid + payment_enabled — advance to step 2 and ask for MoMo number.
    await supabaseAdmin.from('signup_sessions').upsert({
      phone, user_type: 'event_reserve', step: 2,
      data: { ...data, quantity: q, total_price: totalPrice, commission_amount: commissionAmount },
      expires_at: sessionExpiry(15),
    })
    await sendWhatsApp(from,
      `💰 ${q} × ${ticketPrice.toLocaleString()} = *${totalPrice.toLocaleString()} FCFA*\n\n` +
      `Envoyez votre numéro Mobile Money pour payer.\n` +
      `Send your Mobile Money number to pay.\n\n` +
      `Ex: 237670000000\n\n` +
      `Ou "annuler" / Or "cancel"`)
    return ok()
    // eventTitle unused at this step — silence by referencing in the log on success.
    void eventTitle
  }

  // ── event_reserve step 2: MoMo number ──
  if (user_type === 'event_reserve' && step === 2) {
    const eventId       = data?.event_id as string | undefined
    const quantity      = Number(data?.quantity ?? 0)
    const totalPrice    = Number(data?.total_price ?? 0)
    const commissionAmount = Number(data?.commission_amount ?? 0)
    if (!eventId || !quantity || !totalPrice) {
      await supabaseAdmin.from('signup_sessions').delete().eq('phone', phone)
      await sendWhatsApp(from, 'Session expirée. / Session expired.')
      return ok()
    }
    const phoneNumber = cmd.replace(/[^\d+]/g, '')
    if (!phoneNumber) {
      await sendWhatsApp(from, 'Envoyez un numéro MoMo (ex: 237670000000). / Send a MoMo number.')
      return ok()
    }

    const { data: event } = await supabaseAdmin
      .from('events').select('id, title, city, organizer_id, whatsapp, tickets_sold, max_tickets').eq('id', eventId).maybeSingle()
    if (!event) {
      await supabaseAdmin.from('signup_sessions').delete().eq('phone', phone)
      await sendWhatsApp(from, '❌ Événement introuvable. / Event not found.')
      return ok()
    }

    const country = countryFromCity(event.city)
    const mno = detectMNO(phoneNumber, country ?? undefined)
    if (!mno) {
      await sendWhatsApp(from,
        `❌ Numéro non supporté. Réessayez avec un numéro MTN ou Orange avec l'indicatif pays.\n` +
        `Unsupported number. Try an MTN or Orange number with country code.`)
      return ok()
    }

    // Insert the pending reservation + bump tickets_sold (race window
    // mirrors the API path; cleanup happens via the webhook on FAILED).
    const sold = Number(event.tickets_sold ?? 0)
    if (event.max_tickets && event.max_tickets > 0 && sold + quantity > event.max_tickets) {
      await supabaseAdmin.from('signup_sessions').delete().eq('phone', phone)
      await sendWhatsApp(from, '❌ Complet. / Sold out.')
      return ok()
    }
    const { data: reservation, error: insErr } = await supabaseAdmin
      .from('event_reservations')
      .insert({
        event_id:           event.id,
        customer_id:        customer.id,
        customer_name:      customer.name,
        customer_phone:     customer.phone,
        quantity,
        total_price:        totalPrice,
        commission_amount:  commissionAmount,
        payment_status:     'pending',
        reservation_status: 'confirmed',
      }).select('id').single()
    if (insErr || !reservation) {
      await sendWhatsApp(from, `⚠️ Erreur. / Error.`)
      return ok()
    }
    await supabaseAdmin.from('events').update({ tickets_sold: sold + quantity }).eq('id', event.id)

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
      await sendWhatsApp(from, `⚠️ PawaPay: ${msg}. Envoyez "annuler" et réessayez. / Try again.`)
      return ok()
    }
    await supabaseAdmin
      .from('event_reservations')
      .update({ payment_id: depositResult.depositId, payment_method: depositResult.correspondent })
      .eq('id', reservation.id)

    await writeAudit({
      action:          'event_payment_initiated',
      targetType:      'event_reservation',
      targetId:        reservation.id,
      performedBy:     customer.id,
      performedByType: 'customer',
      metadata: {
        event_id:      event.id,
        deposit_id:    depositResult.depositId,
        correspondent: depositResult.correspondent,
        amount:        totalPrice,
        currency:      mno.currency,
        quantity,
        via:           'whatsapp',
      },
    })

    await supabaseAdmin.from('signup_sessions').delete().eq('phone', phone)
    await sendWhatsApp(from,
      `📱 *Validez sur votre téléphone / Confirm on your phone*\n\n` +
      `Un prompt PawaPay va apparaître. Confirmez avec votre code PIN.\n` +
      `A PawaPay prompt will appear. Confirm with your PIN.\n\n` +
      `Vous recevrez un message à la confirmation. / You'll get a message on confirmation.`)
    return ok()
  }

  // Unknown event session shape — quietly clear it.
  await supabaseAdmin.from('signup_sessions').delete().eq('phone', phone)
  await sendWhatsApp(from, 'Session expirée. / Session expired.')
  return ok()
}

// ── Internal helpers for the event flow ──────────────────────────────────────

// Pulls a single event and shows the detail card. Pushes the event_detail
// session so "reserver" without a code resolves to this event.
async function showEventDetail(from: string, phone: string, eventId: string): Promise<NextResponse> {
  const { data: event } = await supabaseAdmin
    .from('events')
    .select('id, title, date, time, venue, neighborhood, city, whatsapp, ticket_price, max_tickets, tickets_sold, payment_enabled, event_status, is_active')
    .eq('id', eventId).maybeSingle()
  if (!event || !event.is_active) {
    await supabaseAdmin.from('signup_sessions').delete().eq('phone', phone)
    await sendWhatsApp(from, `❌ Événement indisponible. / Event unavailable.`)
    return ok()
  }
  const dateStr = new Date(event.date).toLocaleDateString('fr-FR', {
    weekday: 'short', day: '2-digit', month: 'long', year: 'numeric',
  })
  const venueLine = event.venue
    ? `📍 ${event.venue}${event.neighborhood ? ', ' + event.neighborhood : ''}${event.city ? ' — ' + event.city : ''}`
    : ''
  const priceLine = !event.ticket_price || event.ticket_price <= 0
    ? `🎫 Gratuit / Free`
    : `🎫 ${Number(event.ticket_price).toLocaleString()} FCFA / personne`
  const remaining = event.max_tickets && event.max_tickets > 0
    ? Math.max(0, event.max_tickets - Number(event.tickets_sold ?? 0))
    : null
  const capacityLine = remaining != null
    ? `👥 ${remaining} ${remaining > 0 ? 'places restantes / spots remaining' : '— ❌ Complet / Sold out'}`
    : ''
  const tail = remaining === 0
    ? `\n❌ Cet événement est complet.\nThis event is sold out.`
    : `\nEnvoyez "reserver" pour réserver / Send "reserve" to book\n` +
      `Envoyez "retour" pour la liste / Send "back" for the list`

  await supabaseAdmin.from('signup_sessions').upsert({
    phone, user_type: 'event_detail', step: 1,
    data: { event_id: event.id, event_name: event.title },
    expires_at: sessionExpiry(15),
  })

  await sendWhatsApp(from, [
    `🎉 *${event.title}*`,
    `📅 ${dateStr}${event.time ? ` — ${event.time}` : ''}`,
    venueLine,
    priceLine,
    capacityLine,
    event.whatsapp ? `📱 Contact: ${event.whatsapp}` : '',
    tail,
  ].filter(Boolean).join('\n'))
  return ok()
}

// Verifies the event is bookable in-chat and either inserts the
// reservation directly or kicks off the multi-step quantity prompt.
async function startReserveFlow(from: string, phone: string, eventId: string): Promise<NextResponse> {
  const { data: event } = await supabaseAdmin
    .from('events')
    .select('id, title, ticket_price, max_tickets, tickets_sold, payment_enabled, is_active, event_status')
    .eq('id', eventId).maybeSingle()
  if (!event || !event.is_active) {
    await supabaseAdmin.from('signup_sessions').delete().eq('phone', phone)
    await sendWhatsApp(from, '❌ Événement indisponible. / Event unavailable.')
    return ok()
  }
  if (event.event_status && ['cancelled', 'completed'].includes(event.event_status)) {
    await sendWhatsApp(from, '❌ Événement clôturé. / Event closed.')
    return ok()
  }
  const sold = Number(event.tickets_sold ?? 0)
  const remaining = event.max_tickets && event.max_tickets > 0
    ? Math.max(0, event.max_tickets - sold)
    : Infinity
  if (remaining === 0) {
    await sendWhatsApp(from, '❌ Complet. / Sold out.')
    return ok()
  }

  await supabaseAdmin.from('signup_sessions').upsert({
    phone, user_type: 'event_reserve', step: 1,
    data: {
      event_id:        event.id,
      event_name:      event.title,
      ticket_price:    Number(event.ticket_price ?? 0),
      payment_enabled: !!event.payment_enabled,
    },
    expires_at: sessionExpiry(15),
  })
  const cap = remaining === Infinity ? 10 : Math.min(10, remaining)
  await sendWhatsApp(from,
    `Combien de places? (1-${cap})\n` +
    `How many spots? (1-${cap})\n\n` +
    `Ou "annuler" / Or "cancel"`)
  return ok()
}

// Organizer ping for free / pay-at-door reservations. Paid reservations
// notify on the webhook → notifyPaidReservation path.
async function pingOrganizer(
  event:    { id: string; title: string; organizer_id: string | null; whatsapp: string | null },
  customer: OrderingCustomer,
  quantity: number,
  total:    number,
  dateStr:  string,
): Promise<void> {
  let organizerPhone: string | null = null
  if (event.organizer_id) {
    const { data: o } = await supabaseAdmin.from('customers').select('phone').eq('id', event.organizer_id).maybeSingle()
    organizerPhone = o?.phone ?? null
  }
  if (!organizerPhone && event.whatsapp) organizerPhone = event.whatsapp
  if (!organizerPhone) return
  await sendWhatsApp(organizerPhone, [
    `🔔 *Nouvelle réservation / New reservation!*`,
    ``,
    `🎉 ${event.title}`,
    `📅 ${dateStr}`,
    `👤 ${customer.name}`,
    `📱 ${customer.phone}`,
    `🎟 ${quantity} place(s)`,
    total > 0 ? `💰 ${total.toLocaleString()} FCFA` : '',
  ].filter(Boolean).join('\n')).catch(() => null)
}

// ── Public: continue an in-progress ordering session ─────────────────────────
export async function handleOrderingSession(
  from: string,
  phone: string,
  body: string,
  cmd: string,
  session: OrderingSessionRow,
  customer: OrderingCustomer,
): Promise<NextResponse> {
  const { step, data } = session

  // Step 1: waiting for restaurant number
  if (step === 1) {
    const num = parseInt(cmd, 10)
    const candidates = (data as unknown as { candidates?: Array<{ id: string; name: string }> }).candidates ?? []
    if (!Number.isFinite(num) || num < 1 || num > candidates.length) {
      await sendWhatsApp(from, `Envoyez un numéro entre 1 et ${candidates.length}. / Send a number between 1 and ${candidates.length}.`)
      return ok()
    }
    const chosen = candidates[num - 1]
    const menu = await loadAvailableMenu(chosen.id)
    if (menu.length === 0) {
      await sendWhatsApp(from, `🍽️ *${chosen.name}*\n\nCe restaurant n'a pas encore de plat disponible. / No available dishes yet.\nEssayez un autre restaurant. Send "commander" again.`)
      await supabaseAdmin.from('signup_sessions').delete().eq('phone', phone)
      return ok()
    }

    // Closed-restaurant gate. allow_orders_when_closed=false short-circuits
    // the order flow with a hint about the schedule; the default TRUE lets
    // the customer proceed with a banner-style heads-up.
    const { data: restRow } = await supabaseAdmin
      .from('restaurants')
      .select('city, timezone, manual_override, allow_orders_when_closed')
      .eq('id', chosen.id).maybeSingle()
    const { data: hoursRows } = await supabaseAdmin
      .from('restaurant_hours')
      .select('day_of_week, open_time, close_time, is_closed')
      .eq('restaurant_id', chosen.id)
    if (restRow) {
      const { isRestaurantOpen, timezoneForCity, formatHoursForDisplay } = await import('@/lib/openingHours')
      const tz = restRow.timezone || timezoneForCity(restRow.city)
      const status = isRestaurantOpen({
        manual_override: (restRow.manual_override as 'open' | 'closed' | null) ?? null,
        timezone:        tz,
        hours:           (hoursRows ?? []).map(h => ({
          day_of_week: h.day_of_week,
          open_time:   String(h.open_time).slice(0, 5),
          close_time:  String(h.close_time).slice(0, 5),
          is_closed:   !!h.is_closed,
        })),
      })
      if (!status.open) {
        const weekLines = formatHoursForDisplay(
          (hoursRows ?? []).map(h => ({
            day_of_week: h.day_of_week,
            open_time:   String(h.open_time).slice(0, 5),
            close_time:  String(h.close_time).slice(0, 5),
            is_closed:   !!h.is_closed,
          })),
          'fr',
        )
        if (restRow.allow_orders_when_closed === false) {
          // Hard block — abandon the session and tell the customer the
          // schedule so they know when to come back.
          await sendWhatsApp(from,
            `⚠️ *${chosen.name} est fermé / is closed*\n\n` +
            `Horaires / Hours:\n${weekLines.join('\n')}\n\n` +
            `Réessayez à l'ouverture. / Try again when they open.`)
          await supabaseAdmin.from('signup_sessions').delete().eq('phone', phone)
          return ok()
        }
        // Soft warning — keep the session alive but signal the wait.
        const nextLine = status.next_transition?.kind === 'opens'
          ? `Ouvre à ${status.next_transition.at} / Opens at ${status.next_transition.at}.`
          : ''
        await sendWhatsApp(from,
          `⚠️ *${chosen.name}* est fermé actuellement. ${nextLine}\n` +
          `Votre commande sera traitée à l'ouverture.\n` +
          `Currently closed. Your order will be processed when they open.`)
      }
    }
    await supabaseAdmin.from('signup_sessions').update({
      step: 2,
      data: { restaurant_id: chosen.id, restaurant_name: chosen.name, menu },
      expires_at: sessionExpiry(30),
    }).eq('phone', phone)
    await sendWhatsApp(from, buildMenuMessage(chosen.name, menu))
    return ok()
  }

  // Step 2: waiting for order syntax
  if (step === 2) {
    const menu = data.menu ?? []
    const result = parseOrder(body, menu)
    if (!result.ok) {
      await sendWhatsApp(from, `${result.error}\n\nRenvoyez la commande ou "annuler". / Send the order again or "cancel".`)
      return ok()
    }
    await supabaseAdmin.from('signup_sessions').update({
      step: 3,
      data: { ...data, items: result.items, total: result.total },
      expires_at: sessionExpiry(30),
    }).eq('phone', phone)
    await sendWhatsApp(from, buildSummaryMessage(data.restaurant_name, result.items, result.total))
    return ok()
  }

  // Step 3: waiting for oui/non (or a voucher code)
  if (step === 3) {
    if (cmd === 'oui' || cmd === 'yes' || cmd === 'ok') {
      const items = data.items ?? []
      const subtotal = data.total ?? 0
      if (items.length === 0 || subtotal <= 0) {
        await supabaseAdmin.from('signup_sessions').delete().eq('phone', phone)
        await sendWhatsApp(from, '❌ Commande invalide. Recommencez avec "commander". / Invalid order. Start again with "commander".')
        return ok()
      }

      const discount = data.voucher_discount ?? 0
      const total = Math.max(0, subtotal - discount)

      // Resolve payment_enabled + city ahead of insert so the order row
      // carries the right order_type from the start.
      const { data: rest } = await supabaseAdmin
        .from('restaurants')
        .select('payment_enabled, city')
        .eq('id', data.restaurant_id)
        .maybeSingle()
      const paymentEnabled = Boolean(rest?.payment_enabled)
      const restaurantCity = rest?.city ?? ''

      const itemsJsonb = items.map(i => ({ name: i.name, price: i.price, quantity: i.quantity }))
      const { data: newOrder, error: orderErr } = await supabaseAdmin
        .from('orders')
        .insert({
          restaurant_id:   data.restaurant_id,
          customer_id:     customer.id,
          customer_name:   customer.name,
          customer_phone:  customer.phone,
          items:           itemsJsonb,
          total_price:     total,
          status:          'pending',
          voucher_code:    data.voucher_code ?? null,
          discount_amount: discount > 0 ? discount : null,
          order_type:      paymentEnabled ? 'paid_order'  : 'reservation',
          payment_status:  paymentEnabled ? 'pending'     : 'not_required',
        })
        .select('id')
        .single()

      if (orderErr || !newOrder) {
        console.error('[ordering] order insert failed:', orderErr?.message)
        await sendWhatsApp(from, '❌ Erreur lors de la création de la commande. Réessayez. / Error creating order. Please retry.')
        return ok()
      }

      const orderItemsRows = items.map(i => ({
        order_id:     newOrder.id,
        menu_item_id: i.menu_item_id,
        name:         i.name,
        price:        i.price,
        quantity:     i.quantity,
      }))
      const { error: itemsErr } = await supabaseAdmin.from('order_items').insert(orderItemsRows)
      if (itemsErr) console.error('[ordering] order_items insert failed:', itemsErr.message)

      await supabaseAdmin.from('signup_sessions').delete().eq('phone', phone)

      // Consume the voucher if one was applied during this session.
      if (data.voucher_id) {
        await consumeVoucherForOrder(data.voucher_id, customer.id, newOrder.id)
        await writeAudit({
          action: 'voucher_applied',
          targetType: 'voucher',
          targetId: data.voucher_id,
          performedBy: customer.id,
          performedByType: 'customer',
          metadata: { order_id: newOrder.id, code: data.voucher_code, discount },
        })
      }

      await writeAudit({
        action: 'order_created',
        targetType: 'order',
        targetId: newOrder.id,
        performedBy: customer.id,
        performedByType: 'customer',
        metadata: {
          restaurant_id: data.restaurant_id,
          total_price:   total,
          item_count:    items.length,
          voucher_code:  data.voucher_code ?? null,
          discount,
          order_type:    paymentEnabled ? 'paid_order' : 'reservation',
        },
      })

      // ── Paid path: ask for the wallet PIN, defer vendor ping to the
      // payment webhook (a pending payment shouldn't wake up the kitchen).
      if (paymentEnabled) {
        const initiated = await initiateWhatsappPayment(
          from,
          newOrder.id,
          customer.id,
          customer.phone,
          total,
          data.restaurant_name,
          restaurantCity,
        )
        if (!initiated) {
          // Initiation failed — leave the order in payment_status='pending'
          // so the customer can retry with "payer" once they fix the issue.
          await sendWhatsApp(from,
            `⚠️ Impossible de démarrer le paiement. Envoyez "payer" pour réessayer.\n` +
            `Couldn't start payment. Send "pay" to retry.`)
        }
        return ok()
      }

      // ── Reservation path (default): notify vendors immediately. ───────────
      const id4 = last4(newOrder.id)
      const confirmLines = [
        `✅ *Commande confirmée!*`,
        `🧾 Commande #${id4}`,
        `🏪 ${data.restaurant_name}`,
      ]
      if (discount > 0 && data.voucher_code) {
        confirmLines.push(`🏷️ ${data.voucher_code} (−${discount.toLocaleString()} FCFA)`)
      }
      confirmLines.push(`💰 Total: ${total.toLocaleString()} FCFA`)
      const custPrepLine = await prepTimeLine(data.restaurant_id)
      if (custPrepLine) confirmLines.push(custPrepLine)
      confirmLines.push(``, `Le restaurant a été notifié. Vous recevrez un message quand votre commande sera prête!`)
      confirmLines.push(`The restaurant has been notified. You'll receive a message when your order is ready!`)
      await sendWhatsApp(from, confirmLines.join('\n'))

      // Fan out to vendors — must be awaited. Fire-and-forget here dies with
      // the serverless response lifecycle on Vercel, which is the root cause
      // of "vendors don't get notified" reports.
      try {
        await notifyVendorsOfNewOrder(
          data.restaurant_id,
          data.restaurant_name,
          newOrder.id,
          customer.name,
          customer.phone,
          items,
          total,
        )
      } catch (e) {
        console.error('[ordering] vendor fan-out failed:', (e as Error).message)
      }

      return ok()
    }

    if (cmd === 'non' || cmd === 'no') {
      await supabaseAdmin.from('signup_sessions').delete().eq('phone', phone)
      await sendWhatsApp(from, '❌ Commande annulée. Envoyez "commander" pour recommencer. / Cancelled. Send "commander" to start over.')
      return ok()
    }

    // Otherwise treat the input as a voucher code attempt. Any non-empty
    // token that isn't oui/non is tried as a code — liberal on input,
    // explicit on errors.
    const maybeCode = body.trim().toUpperCase()
    if (maybeCode.length >= 3) {
      const subtotal = data.total ?? 0
      const result = await validateVoucher(maybeCode, {
        customerId:   customer.id,
        restaurantId: data.restaurant_id,
        orderTotal:   subtotal,
        city:         customer.city,
      })
      if (!result.ok) {
        await sendWhatsApp(from, `❌ ${result.message}\n\nEnvoyez "oui" pour confirmer ou "non" pour annuler. / Send "yes" to confirm or "no" to cancel.`)
        return ok()
      }
      await supabaseAdmin.from('signup_sessions').update({
        data: {
          ...data,
          voucher_id:       result.voucher.id,
          voucher_code:     result.voucher.code,
          voucher_discount: result.discount,
        },
        expires_at: sessionExpiry(30),
      }).eq('phone', phone)

      const lines = (data.items ?? []).map(i => `${i.quantity}× ${i.name} — ${(i.quantity * i.price).toLocaleString()} FCFA`)
      await sendWhatsApp(from, [
        `🏷️ Code *${result.voucher.code}* appliqué! / applied!`,
        ``,
        `🏪 ${data.restaurant_name}`,
        ...lines,
        ``,
        `Sous-total / Subtotal: ${subtotal.toLocaleString()} FCFA`,
        `Remise / Discount: −${result.discount.toLocaleString()} FCFA`,
        `💰 *Nouveau total / New total: ${result.finalTotal.toLocaleString()} FCFA*`,
        ``,
        `Envoyez "oui" pour confirmer ou "non" pour annuler.`,
        `Send "yes" to confirm or "no" to cancel.`,
      ].join('\n'))
      return ok()
    }

    await sendWhatsApp(from, 'Envoyez "oui" pour confirmer, "non" pour annuler, ou un code promo. / Send "yes", "no", or a voucher code.')
    return ok()
  }

  // Unexpected step
  await supabaseAdmin.from('signup_sessions').delete().eq('phone', phone)
  await sendWhatsApp(from, 'Session expirée. Envoyez "aide". / Session expired. Send "help".')
  return ok()
}

// ── Public: vendor order actions ─────────────────────────────────────────────
// Walks the order through the full kitchen lifecycle from WhatsApp, with the
// same payment gate as the web dashboard:
//   ok XXXX        → pending  → confirmed   (blocked if paid_order + not paid)
//   preparer XXXX  → confirmed → preparing
//   pret XXXX      → preparing → ready
//   recupere XXXX  → ready    → delivered
//   annuler XXXX   → * → cancelled
//   paye XXXX cash|mtn <phone>|orange <phone> → manual mark-as-paid

// Public URL used in WhatsApp deep links. Mirrors the constant in
// app/api/whatsapp/incoming/route.ts — kept local so this module is
// self-contained.
const BASE_URL = 'https://streetmenu.vercel.app'

type ManualPaymentMethod = 'cash' | 'mtn_momo' | 'orange_money'
const MANUAL_METHOD_LABEL: Record<ManualPaymentMethod, { fr: string; en: string }> = {
  cash:         { fr: 'Espèces',      en: 'Cash' },
  mtn_momo:     { fr: 'MTN MoMo',     en: 'MTN MoMo' },
  orange_money: { fr: 'Orange Money', en: 'Orange Money' },
}

interface VendorIntent {
  kind: 'status'  | 'cancel' | 'paye'
  code4: string
  target?: 'confirmed' | 'preparing' | 'ready' | 'delivered'
  method?: ManualPaymentMethod
  payerPhone?: string
}

// Returns null when the body isn't a recognised vendor verb — caller falls
// through to other intents (menu, team, etc.). Returns a parsed intent when
// the verb shape matches; the caller doesn't have to know the regex layout.
function parseVendorIntent(body: string): VendorIntent | null {
  // Status transitions — keep "pending → confirmed" first so "ok" wins
  // ahead of any generic verb that could also start with "ok".
  const okMatch       = body.match(/^ok\s+([0-9a-f]{4})$/i)
  if (okMatch) return { kind: 'status', target: 'confirmed', code4: okMatch[1] }

  const prepMatch     = body.match(/^(?:preparer|préparer|preparing)\s+([0-9a-f]{4})$/i)
  if (prepMatch) return { kind: 'status', target: 'preparing', code4: prepMatch[1] }

  const readyMatch    = body.match(/^(?:pret|prêt|ready)\s+([0-9a-f]{4})$/i)
  if (readyMatch) return { kind: 'status', target: 'ready', code4: readyMatch[1] }

  const deliverMatch  = body.match(/^(?:livre|livré|delivered|recupere|récupéré|picked\s*up)\s+([0-9a-f]{4})$/i)
  if (deliverMatch) return { kind: 'status', target: 'delivered', code4: deliverMatch[1] }

  const cancelMatch   = body.match(/^(?:annuler|cancel)\s+([0-9a-f]{4})$/i)
  if (cancelMatch) return { kind: 'cancel', code4: cancelMatch[1] }

  // paye XXXX <method> [phone]
  const payeMatch = body.match(/^(?:paye|payé|paid)\s+([0-9a-f]{4})\s+(.+)$/i)
  if (payeMatch) {
    const code4 = payeMatch[1]
    const rest  = payeMatch[2].trim()
    if (/^(?:cash|esp[eè]ces)$/i.test(rest)) {
      return { kind: 'paye', method: 'cash', code4 }
    }
    const mtn = rest.match(/^(?:mtn(?:_momo)?|mtn\s+momo|momo)\s+([\d+\s-]+)$/i)
    if (mtn) return { kind: 'paye', method: 'mtn_momo', code4, payerPhone: mtn[1].trim() }
    const orange = rest.match(/^(?:orange(?:_money)?|orange\s+money)\s+([\d+\s-]+)$/i)
    if (orange) return { kind: 'paye', method: 'orange_money', code4, payerPhone: orange[1].trim() }
  }

  return null
}

export async function handleVendorOrderAction(
  from: string,
  body: string,
  restaurant: { id: string; name: string },
): Promise<NextResponse | null> {
  const intent = parseVendorIntent(body)
  if (!intent) return null

  const code4 = intent.code4.toLowerCase()
  const upper = code4.toUpperCase()

  // Status filter: include 'delivered' in the search window even though it's
  // terminal — the vendor may want to mark a just-delivered order as paid in
  // cash. Truly closed orders ('completed' legacy + 'cancelled') stay out.
  const { data: orders } = await supabaseAdmin
    .from('orders')
    .select('id, status, customer_phone, customer_name, total_price, created_at, items, order_type, payment_status, payment_id')
    .eq('restaurant_id', restaurant.id)
    .not('status', 'in', '(completed,cancelled)')
    .order('created_at', { ascending: false })
    .limit(50)

  const matching = (orders ?? []).filter(o => o.id.replace(/-/g, '').toLowerCase().endsWith(code4))

  if (matching.length === 0) {
    await sendWhatsApp(from, `❌ Commande #${upper} introuvable pour ${restaurant.name}. / Order not found.`)
    return ok()
  }
  if (matching.length > 1) {
    await sendWhatsApp(from, `⚠️ Plusieurs commandes correspondent à #${upper}. Contactez le support. / Multiple orders match.`)
    return ok()
  }

  const order = matching[0]
  const payload = {
    id:             order.id,
    customer_name:  order.customer_name,
    customer_phone: order.customer_phone,
    items:          (order.items as Array<{ name: string; quantity: number; price: number }>) ?? [],
    total_price:    Number(order.total_price),
    created_at:     order.created_at,
  }

  // ── Manual mark-as-paid ────────────────────────────────────────────────────
  if (intent.kind === 'paye') {
    if (order.payment_id) {
      await sendWhatsApp(from, `❌ Commande #${upper} déjà payée dans l'app. / Order already paid in-app.`)
      return ok()
    }
    if (order.payment_status === 'paid') {
      await sendWhatsApp(from, `Commande #${upper} déjà payée. / already paid.`)
      return ok()
    }

    const method = intent.method!
    const { error: updErr } = await supabaseAdmin.from('orders').update({
      payment_status:       'paid',
      payment_method:       method,
      payment_at:           new Date().toISOString(),
      payment_amount:       Math.round(Number(order.total_price)),
      manual_payment_phone: intent.payerPhone ?? null,
      updated_at:           new Date().toISOString(),
    }).eq('id', order.id)

    if (updErr) {
      console.error('[ordering] mark-paid update failed:', updErr.message)
      const hint = /manual_payment_phone|column .* does not exist/i.test(updErr.message)
        ? ' (run supabase-manual-payment.sql)'
        : ''
      await sendWhatsApp(from, `⚠️ Impossible de marquer payé: ${updErr.message}${hint}. / Couldn't mark paid.`)
      return ok()
    }

    await writeAudit({
      action:          'payment_marked_paid',
      targetType:      'order',
      targetId:        order.id,
      performedBy:     restaurant.id,
      performedByType: 'vendor',
      previousData:    { payment_status: order.payment_status },
      metadata: {
        method,
        payer_phone: intent.payerPhone ?? null,
        marked_by:   restaurant.id,
        via:         'whatsapp',
      },
    })

    const label = MANUAL_METHOD_LABEL[method]
    await sendWhatsApp(from,
      `💰 Paiement confirmé pour #${upper} (${label.fr}). Vous pouvez maintenant confirmer la commande.\n` +
      `Payment confirmed for #${upper} (${label.en}). You can now confirm the order.`)

    // Mirror the API route — let the customer know their tab is settled.
    if (order.customer_phone) {
      await sendWhatsApp(order.customer_phone, [
        `💰 *Paiement confirmé par ${restaurant.name} / Payment confirmed by ${restaurant.name}*`,
        ``,
        `🧾 Commande #${upper}`,
        `💳 ${label.fr} / ${label.en}`,
        `💰 ${Number(order.total_price).toLocaleString()} FCFA`,
        ``,
        `Merci! / Thank you!`,
      ].join('\n'))
    }
    return ok()
  }

  // ── Cancellation — allowed from any non-terminal state ─────────────────────
  if (intent.kind === 'cancel') {
    const { error: updErr } = await supabaseAdmin.from('orders').update({
      status: 'cancelled', updated_at: new Date().toISOString(),
    }).eq('id', order.id)
    if (updErr) {
      console.error('[ordering] cancel update failed — migration likely not applied:', updErr.message)
      await sendWhatsApp(from, `⚠️ Impossible d'annuler: migration manquante. Contactez le support. / Cannot cancel: migration not applied.`)
      return ok()
    }
    await writeAudit({ action: 'order_cancelled', targetType: 'order', targetId: order.id, performedBy: restaurant.id, performedByType: 'vendor' })
    await sendWhatsApp(from, `❌ Commande #${upper} annulée. Le client est notifié. / cancelled, customer notified.`)
    await notifyCustomerOrderCancelled(order.customer_phone, payload, restaurant.name)
    return ok()
  }

  // ── Status transitions ─────────────────────────────────────────────────────
  // Payment gate on the very first transition out of 'pending' (confirm). A
  // paid_order that still says payment_status='pending'/'failed' shouldn't
  // wake up the kitchen — vendors must either wait for the deposit to land
  // or mark the order paid (cash/MoMo) first.
  if (intent.target === 'confirmed'
      && order.order_type === 'paid_order'
      && order.payment_status !== 'paid') {
    await sendWhatsApp(from,
      `⏳ Le paiement n'est pas encore confirmé pour la commande #${upper}.\n` +
      `Payment has not been confirmed yet for order #${upper}.`)
    return ok()
  }

  // Strict: each verb only progresses one step. This forces a paid_order
  // through the confirm gate (where the payment check lives) rather than
  // letting "preparer" skip straight ahead while the deposit is still
  // pending.
  const ALLOWED_FROM: Record<NonNullable<VendorIntent['target']>, string[]> = {
    confirmed: ['pending'],
    preparing: ['confirmed'],
    ready:     ['preparing'],
    delivered: ['ready'],
  }
  const target = intent.target!
  if (!ALLOWED_FROM[target].includes(order.status)) {
    await sendWhatsApp(from, `Commande #${upper} en statut ${order.status}, transition vers ${target} impossible. / cannot transition.`)
    return ok()
  }

  const { error: updErr } = await supabaseAdmin
    .from('orders')
    .update({ status: target, updated_at: new Date().toISOString() })
    .eq('id', order.id)
  if (updErr) {
    console.error(`[ordering] status update to ${target} failed:`, updErr.message)
    await sendWhatsApp(from, `⚠️ Impossible de mettre à jour: ${updErr.message}. / Couldn't update.`)
    return ok()
  }
  await writeAudit({
    action:          `order_${target}`,
    targetType:      'order',
    targetId:        order.id,
    performedBy:     restaurant.id,
    performedByType: 'vendor',
    previousData:    { status: order.status },
  })

  // Vendor ack + customer ping per target.
  if (target === 'confirmed') {
    await sendWhatsApp(from, `✅ Commande #${upper} confirmée. Le client est notifié. / confirmed, customer notified.`)
    await notifyCustomerOrderConfirmed(order.customer_phone, payload, restaurant.name)
  } else if (target === 'preparing') {
    await sendWhatsApp(from, `🍳 Commande #${upper} en préparation. Le client est notifié. / preparing, customer notified.`)
    await notifyCustomerOrderPreparing(order.customer_phone, payload, restaurant.name)
  } else if (target === 'ready') {
    await sendWhatsApp(from, `🎉 Commande #${upper} prête. Le client est notifié. / ready, customer notified.`)
    await notifyCustomerOrderReady(order.customer_phone, payload, restaurant.name)
  } else if (target === 'delivered') {
    await sendWhatsApp(from, `📦 Commande #${upper} récupérée. Le client est notifié. / picked up, customer notified.`)
    await notifyCustomerOrderDelivered(order.customer_phone, payload, restaurant.name)
  }
  return ok()
}
