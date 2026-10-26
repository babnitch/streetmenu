// WhatsApp ordering flow — customer-side state machine + vendor order actions.
// See docs/superpowers/specs/2026-04-18-whatsapp-ordering-design.md

import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { writeAudit } from '@/lib/audit'
import {
  sendWhatsApp as sendWhatsAppBase,
  notifyCustomerOrderConfirmed,
  notifyCustomerOrderPreparing,
  notifyCustomerOrderReady,
  notifyCustomerOrderDelivered,
  notifyCustomerOrderCancelled,
  pickLang,
  getLangByPhone,
  normalizeLang,
  type Lang,
  type SendOptions,
  type SendResult,
} from '@/lib/whatsapp'
import { validateVoucher, consumeVoucherForOrder, consumeVoucherForReservation, isPercentDiscount } from '@/lib/vouchers'
import { createDeposit, checkDepositStatus, detectMNO, countryFromCity, isPawaPayTimeout } from '@/lib/pawapay'
import { randomUUID } from 'crypto'
import { closeReservation, reserveEventSeats, getEventAvailability, type ReserveSeatsResult } from '@/lib/eventSeats'
import { formatPrepTime } from '@/lib/prepTime'
import { sendEventMessage } from '@/lib/directMessaging'
import { generateReservationCode } from '@/lib/reservationCode'
import {
  normalizeMode, modeFromLegacy, effectiveWhatsAppMode, type PaymentMode,
} from '@/lib/paymentMode'
import { samePhone } from '@/lib/phone'
import { isEventOrganizer } from '@/lib/eventAuth'
import { isPastEvent, PAST_EVENT_MESSAGE_FR, PAST_EVENT_MESSAGE_EN, EVENT_DATE_COLUMNS, formatEventDates, formatEventWhen, isMultiDay, resolveBookingDay, todayISO } from '@/lib/eventDate'

// Every send from this module is a reply in the WhatsApp bot conversation,
// so it lands in the message log as 'bot_reply' unless the call site says
// otherwise (order notifications and reservation confirmations override it).
// Wrapping here beats threading an options object through ~150 call sites.
function sendWhatsApp(to: string, message: string, opts: SendOptions = {}): Promise<SendResult> {
  return sendWhatsAppBase(to, message, { context: 'bot_reply', ...opts })
}

// Reads the restaurant's estimated prep range and formats a single-language
// WhatsApp line like "🕐 Temps estimé: 20-35 min", or '' when the vendor
// hasn't set one. The leading emoji is caller-supplied so the vendor ping
// can use ⏱️ while customer messages use 🕐. `lang` controls FR vs EN —
// callers pass the recipient's preferred_language. Vendor pings default to
// FR (the most common vendor language) until vendor preference threading
// lands.
export async function prepTimeLine(
  restaurantId: string,
  emoji = '🕐',
  lang: Lang = 'fr',
): Promise<string> {
  const { data } = await supabaseAdmin
    .from('restaurants')
    .select('prep_time_min, prep_time_max')
    .eq('id', restaurantId)
    .maybeSingle()
  const label = formatPrepTime(data?.prep_time_min, data?.prep_time_max)
  if (!label) return ''
  return `${emoji} ${pickLang('Temps estimé', 'Estimated time', lang)}: ${label}`
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

// PostgREST filter matching either link column an event can carry to its
// publisher. Mirrors lib/eventAuth.isEventOrganizer + /api/events/my, so an
// organizer whose event predates `organizer_id` still sees it in chat.
function organizerScope(customerId: string): string {
  return `organizer_id.eq.${customerId},submitted_by.eq.${customerId}`
}

// Resolve a reservation from a typed short code, scoped to events the given
// organizer owns. Primary match is the stored reservation_code; falls back to
// the legacy UUID-last-4 so codes quoted before the migration still resolve.
interface ResolvedReservation {
  id: string; event_id: string; reservation_status: string; reservation_code: string | null
  quantity: number; customer_name: string; customer_phone: string
  events: { organizer_id: string | null; submitted_by: string | null; whatsapp: string | null; title: string } | null
}
const RESERVATION_COLS =
  'id, event_id, reservation_status, reservation_code, quantity, customer_name, customer_phone, events!inner(organizer_id, submitted_by, whatsapp, title)'

async function resolveReservationByCode(
  organizerId: string,
  code: string,
  // Sender's phone. Events published without an account link carry only
  // events.whatsapp, so organizer_id alone would never resolve them and the
  // organizer would be told their own reservation doesn't exist.
  organizerPhone?: string | null,
): Promise<ResolvedReservation | null> {
  // Organizers copy the code straight out of the notification, '#' and all.
  const clean = code.trim().replace(/^#/, '').trim()
  console.log('[whatsapp/reservation] resolving code=%s organizer=%s phone=%s', clean, organizerId, organizerPhone ?? '-')

  const { data, error } = await supabaseAdmin
    .from('event_reservations')
    .select(RESERVATION_COLS)
    .eq('events.organizer_id', organizerId)
    .ilike('reservation_code', clean)
    .limit(1)
  if (error) console.error('[whatsapp/reservation] code lookup failed:', error.message)
  if (data && data.length) {
    console.log('[whatsapp/reservation] matched by code → reservation=%s', data[0].id)
    return data[0] as unknown as ResolvedReservation
  }

  // Events linked to their publisher through the legacy `submitted_by`
  // column rather than `organizer_id` — same rule as lib/eventAuth.
  const { data: bySubmitter } = await supabaseAdmin
    .from('event_reservations')
    .select(RESERVATION_COLS)
    .eq('events.submitted_by', organizerId)
    .ilike('reservation_code', clean)
    .limit(1)
  if (bySubmitter && bySubmitter.length) {
    console.log('[whatsapp/reservation] matched by code + submitted_by → reservation=%s', bySubmitter[0].id)
    return bySubmitter[0] as unknown as ResolvedReservation
  }

  // Same code, but scoped by the event's WhatsApp contact instead of the
  // organizer account.
  if (organizerPhone) {
    const { data: byCode } = await supabaseAdmin
      .from('event_reservations')
      .select(RESERVATION_COLS)
      .ilike('reservation_code', clean)
      .limit(20)
    const hit = ((byCode ?? []) as unknown as ResolvedReservation[])
      .find(r => samePhone(r.events?.whatsapp, organizerPhone))
    if (hit) {
      console.log('[whatsapp/reservation] matched by code + event whatsapp → reservation=%s', hit.id)
      return hit
    }
  }

  // Legacy fallback — match the trailing 4 hex of the UUID (codes quoted
  // before the reservation_code migration).
  const low = clean.toLowerCase()
  const { data: all } = await supabaseAdmin
    .from('event_reservations')
    .select(RESERVATION_COLS)
    .eq('events.organizer_id', organizerId)
    .order('created_at', { ascending: false })
    .limit(300)
  const legacy = ((all ?? []) as unknown as ResolvedReservation[])
    .find(r => r.id.replace(/-/g, '').toLowerCase().endsWith(low)) ?? null
  console.log('[whatsapp/reservation] legacy uuid match: %s', legacy ? legacy.id : 'none')
  return legacy
}

// ── Types ────────────────────────────────────────────────────────────────────
export interface OrderingCustomer {
  id: string
  name: string
  phone: string
  city: string
  preferred_language?: string | null
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
  // Cached on the session when a 'both'-mode order pauses for the pay-vs-reserve
  // choice (step 4), so finalising doesn't need to re-fetch the restaurant.
  restaurant_city?: string
  // Event-reserve sessions reuse this blob; these keep the event flow typed.
  event_id?: string
  event_name?: string
  ticket_price?: number
  payment_enabled?: boolean
  payment_mode?: PaymentMode
  whatsapp_payment_enabled?: boolean
  quantity?: number
  total_price?: number
  commission_amount?: number
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

function buildRestaurantListMessage(restaurants: Array<{ name: string; cuisine_type: string; city?: string }>, scopedToCity: string | null, lang: Lang = 'fr'): string {
  const header = scopedToCity
    ? pickLang(`🍽️ *Restaurants à ${scopedToCity}:*`, `🍽️ *Restaurants in ${scopedToCity}:*`, lang)
    : pickLang(`🍽️ *Tous les restaurants:*`, `🍽️ *All restaurants:*`, lang)
  const lines = restaurants.map((r, i) => `${i + 1}. ${r.name} — ${r.cuisine_type}`)
  return [
    header,
    '',
    lines.join('\n'),
    '',
    pickLang(`Envoyez le numéro du restaurant`, `Send the restaurant number`, lang),
    pickLang(`_Envoyez "annuler" pour annuler_`, `_Send "cancel" to cancel_`, lang),
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

function buildMenuMessage(restaurantName: string, menu: MenuItemRef[], lang: Lang = 'fr'): string {
  if (menu.length === 0) {
    return `🍽️ *${restaurantName}*\n\n${pickLang('Menu vide.', 'Empty menu.', lang)}\n\n${pickLang('_Envoyez "annuler" pour choisir un autre restaurant_', '_Send "cancel" to pick another restaurant_', lang)}`
  }
  const lines = menu.map((m, i) => `${i + 1}. ${m.name} — ${Number(m.price).toLocaleString()} FCFA`)
  return [
    `🍽️ *${restaurantName}*`,
    '',
    lines.join('\n'),
    '',
    pickLang(`Envoyez votre commande:`, `Send your order:`, lang),
    `_Ex: 1 x2, 3 x1 (2 ${menu[0]?.name ?? 'item'} + 1 ${menu[2]?.name ?? menu[Math.min(1, menu.length - 1)]?.name ?? 'item'})_`,
    pickLang(`_Envoyez "annuler" pour annuler_`, `_Send "cancel" to cancel_`, lang),
  ].join('\n')
}

// ── Order parser ─────────────────────────────────────────────────────────────
export interface ParseOk { ok: true; items: CartItem[]; total: number }
export interface ParseErr { ok: false; error: string }

// Shared "didn't recognise the item" guidance. The previous messages
// ("Numéro X invalide", "Format non compris", and — worst — the voucher
// lookup's "Code introuvable") left customers guessing. This spells out the
// exact menu syntax they need.
export function itemNotFoundMessage(lang: Lang = 'fr'): string {
  return pickLang(
    `Plat introuvable. Envoyez le numéro du menu (ex: "1" pour le 1er plat, "2x3" pour 3 du plat 2).`,
    `Item not found. Send the number from the menu list (e.g. "1" for the first item, "2x3" for 3 of item 2).`,
    lang,
  )
}

export function parseOrder(raw: string, menu: MenuItemRef[], lang: Lang = 'fr'): ParseOk | ParseErr {
  const tokens = raw.split(/[,\n]/).map(t => t.trim()).filter(Boolean)
  if (tokens.length === 0) return { ok: false, error: pickLang('Commande vide', 'Empty order', lang) }

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
      if (!menuItem) return { ok: false, error: itemNotFoundMessage(lang) }
    } else if (nameBased) {
      qty = parseInt(nameBased[1], 10)
      const name = nameBased[2].trim().toLowerCase()
      menuItem = menu.find(m => m.name.toLowerCase() === name) ||
                 menu.find(m => m.name.toLowerCase().includes(name))
      if (!menuItem) return { ok: false, error: itemNotFoundMessage(lang) }
    } else {
      return { ok: false, error: itemNotFoundMessage(lang) }
    }

    if (!Number.isFinite(qty) || qty < 1 || qty > 99) {
      return { ok: false, error: pickLang(`Quantité invalide: ${qty}`, `Invalid quantity: ${qty}`, lang) }
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

function buildSummaryMessage(restaurantName: string, items: CartItem[], total: number, lang: Lang = 'fr'): string {
  const lines = items.map(i => `${i.quantity}× ${i.name} — ${(i.quantity * i.price).toLocaleString()} FCFA`)
  return [
    pickLang(`📦 *Votre commande:*`, `📦 *Your order:*`, lang),
    '',
    `🏪 ${restaurantName}`,
    ...lines,
    '',
    `💰 *Total: ${total.toLocaleString()} FCFA*`,
    '',
    pickLang(`Envoyez "oui" pour confirmer ou "non" pour annuler`, `Send "yes" to confirm or "no" to cancel`, lang),
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

  // Name the FK — restaurant_team has two into customers (customer_id,
  // added_by), and the bare embed was failing with PGRST201, silently
  // dropping every owner/manager phone from the fan-out. The
  // restaurants.whatsapp seeding above is untouched; on failure we still
  // return whatever that produced rather than losing the notification.
  const { data: team, error } = await supabaseAdmin
    .from('restaurant_team')
    .select('role, customers!restaurant_team_customer_id_fkey(phone)')
    .eq('restaurant_id', restaurantId)
    .eq('status', 'active')
    .in('role', ['owner', 'manager'])

  if (error) {
    console.error('[ordering] vendorRecipients: team phone lookup failed:', error.code, error.message)
  }

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
  // Render per recipient in their stored language (prep line included).
  const buildMsg = async (lang: Lang): Promise<string> => {
    const prepLine = await prepTimeLine(restaurantId, '⏱️', lang)
    return [
      pickLang(`🔔 *NOUVELLE COMMANDE!*`, `🔔 *NEW ORDER!*`, lang),
      `━━━━━━━━━━━━━━━━━━`,
      ``,
      pickLang(`🧾 Commande #${id4}`, `🧾 Order #${id4}`, lang),
      `🏪 ${restaurantName}`,
      `👤 ${customerName}`,
      `📱 ${customerPhone}`,
      ``,
      pickLang(`🍽️ *Articles:*`, `🍽️ *Items:*`, lang),
      itemLines,
      ``,
      `💰 *Total: ${total.toLocaleString()} FCFA*`,
      ...(prepLine ? [``, prepLine] : []),
      ``,
      `━━━━━━━━━━━━━━━━━━`,
      pickLang(`Répondez "ok ${id4}" pour confirmer`, `Reply "ok ${id4}" to confirm`, lang),
      pickLang(`Répondez "annuler ${id4}" pour annuler`, `Reply "cancel ${id4}" to cancel`, lang),
    ].join('\n')
  }
  // Cache the two renderings so we don't rebuild per recipient.
  const msgByLang: Partial<Record<Lang, string>> = {}
  const results = await Promise.allSettled(recipients.map(async p => {
    const lang = await getLangByPhone(p)
    const msg = msgByLang[lang] ?? (msgByLang[lang] = await buildMsg(lang))
    return sendWhatsApp(p, msg, { context: 'order_notification', relatedId: orderId })
  }))
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

// How a createDeposit failure should be told to the customer. `definitive`
// means PawaPay refused the deposit (or we never sent it) — no prompt will
// appear. Otherwise the outcome is unknown (timeout, network, PawaPay 5xx):
// the deposit may exist, so the row keeps its payment_id and the webhook or
// the reconcile job settles it.
export function depositFailure(e: unknown): { definitive: boolean; reason: string } {
  if (isPawaPayTimeout(e) || e instanceof TypeError) {
    return { definitive: false, reason: (e as Error).message }
  }
  const msg = (e as Error)?.message ?? String(e)
  if (/HTTP 5\d\d/.test(msg)) return { definitive: false, reason: msg }
  // createDeposit's messages are "<fr> / <en>: <PawaPay reason>"; keep only
  // PawaPay's own reason so the customer gets one language plus the cause.
  const m = msg.match(/Payment rejected: (.*)$/)
  return { definitive: true, reason: (m ? m[1] : msg).trim() }
}

// Points a pending or failed order at a NEW deposit and makes it 'pending'
// again, in one conditional update. Returns false when the order is no longer
// awaiting payment (e.g. already paid); throws on a database error.
export async function claimOrderForDeposit(
  orderId: string,
  depositId: string,
  correspondent: string,
  total: number,
): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from('orders')
    .update({
      payment_id:     depositId,
      payment_status: 'pending',
      payment_method: correspondent,
      payment_amount: total,
    })
    .eq('id', orderId)
    .in('payment_status', ['pending', 'failed'])
    .select('id')
    .maybeSingle()
  if (error) throw new Error(`claim order ${orderId}: ${error.message}`)
  return !!data
}

// Internal: kicks off a PawaPay deposit for a paid_order WhatsApp order and
// tells the customer to confirm on their phone. Used for the first attempt
// and for every "payer" retry. The final success/failure messaging is
// dispatched by settleDeposit (webhook / reconcile), the source of truth for
// terminal payment status.
//
// The order is claimed for a NEW deposit id before PawaPay is called: one
// conditional update sets payment_id and resets payment_status to 'pending'
// (a retry after a failure must, or settleDeposit's pending-only claim would
// ignore the new deposit's callback and the customer would pay into silence).
// Writing the id first also means a callback that beats our own update, or a
// request that times out after PawaPay created the deposit, still matches.
//
// Always tells the customer what happened; returns true when the prompt is
// on its way.
async function initiateWhatsappPayment(
  from:           string,
  orderId:        string,
  customerId:     string,
  customerPhone:  string,
  total:          number,
  restaurantName: string,
  restaurantCity: string,
  lang:           Lang = 'fr',
): Promise<boolean> {
  const country = countryFromCity(restaurantCity)
  const mno = detectMNO(customerPhone, country ?? undefined)
  if (!mno) {
    await sendWhatsApp(from, pickLang(
      `❌ Numéro non supporté pour le paiement mobile.`,
      `❌ Phone not supported for mobile payment.`,
      lang,
    ))
    return false
  }

  const depositId = randomUUID()
  let claimed = false
  let claimErr: Error | null = null
  try {
    claimed = await claimOrderForDeposit(orderId, depositId, mno.correspondent, total)
  } catch (e) {
    claimErr = e as Error
  }
  if (claimErr || !claimed) {
    console.error(`[ordering] payment claim failed order=${orderId}: ${claimErr?.message ?? 'order not pending/failed (already paid?)'}`)
    await sendWhatsApp(from, pickLang(
      claimErr
        ? `⚠️ Impossible de démarrer le paiement. Envoyez "payer" pour réessayer.`
        : `ℹ️ Cette commande n'attend plus de paiement.`,
      claimErr
        ? `⚠️ Couldn't start payment. Send "pay" to retry.`
        : `ℹ️ This order is no longer awaiting payment.`,
      lang,
    ))
    return false
  }

  try {
    await createDeposit({
      amount:      total,
      currency:    mno.currency,
      phoneNumber: customerPhone,
      orderId,
      description: `${restaurantName} ${orderId.slice(0, 6)}`,
      depositId,
    })
  } catch (e) {
    const f = depositFailure(e)
    console.error(`[ordering] createDeposit failed order=${orderId} deposit=${depositId} definitive=${f.definitive}: ${(e as Error).message}`)
    await sendWhatsApp(from, f.definitive
      ? pickLang(
          `❌ Paiement refusé : ${f.reason}\n\nEnvoyez "payer" pour réessayer.`,
          `❌ Payment refused: ${f.reason}\n\nSend "pay" to try again.`,
          lang)
      : pickLang(
          `⏳ Le service de paiement ne répond pas. Si une demande de paiement apparaît sur votre téléphone, vous pouvez la valider — vous recevrez une confirmation. Sinon, envoyez "payer" dans 2 minutes.`,
          `⏳ The payment service is not responding. If a payment prompt appears on your phone you can approve it — you'll get a confirmation. Otherwise send "pay" in 2 minutes.`,
          lang))
    return false
  }

  // Remember the wallet used for the next order's pre-fill. On WhatsApp the
  // customer's account phone is also their MoMo number (Twilio gave us the
  // wallet number for free), so we save it the same way the web flow does.
  const { error: momoErr } = await supabaseAdmin
    .from('customers')
    .update({ momo_phone: customerPhone })
    .eq('id', customerId)
  if (momoErr) console.error(`[ordering] momo_phone save failed customer=${customerId}: ${momoErr.message}`)

  await writeAudit({
    action:     'payment_initiated',
    targetType: 'order',
    targetId:   orderId,
    metadata: {
      deposit_id:    depositId,
      correspondent: mno.correspondent,
      amount:        total,
      currency:      mno.currency,
      via:           'whatsapp',
    },
  })

  await sendWhatsApp(from, pickLang([
    `💰 *Commande de ${total.toLocaleString()} FCFA*`,
    ``,
    `Un prompt de paiement va apparaître sur votre téléphone. Confirmez le paiement avec votre code PIN mobile money.`,
    ``,
    `_Si rien n'apparaît dans 2 minutes, envoyez "payer" pour réessayer._`,
  ].join('\n'), [
    `💰 *Order of ${total.toLocaleString()} FCFA*`,
    ``,
    `A payment prompt will appear on your phone. Confirm the payment with your mobile money PIN.`,
    ``,
    `_If nothing appears within 2 minutes, send "pay" to retry._`,
  ].join('\n'), lang))

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
  const lang = normalizeLang(customer.preferred_language)

  const { data: order } = await supabaseAdmin
    .from('orders')
    .select('id, restaurant_id, total_price, payment_status, payment_id, restaurants!orders_restaurant_id_fkey(name, city)')
    .eq('customer_id', customer.id)
    .eq('order_type', 'paid_order')
    .in('payment_status', ['pending', 'failed'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!order) {
    await sendWhatsApp(from, pickLang(
      `Aucune commande en attente de paiement. Envoyez "commander" pour en créer une.`,
      `No order awaiting payment. Send "commander" to create one.`,
      lang,
    ))
    return ok()
  }

  // A pending order may still have a deposit in flight. Starting a second
  // one would overwrite payment_id, and if the customer then approved the
  // FIRST prompt its callback would match nothing — paid, never confirmed.
  // So ask PawaPay first: settle it if it already finished, and refuse a new
  // deposit while it is still running.
  if (order.payment_status === 'pending' && order.payment_id) {
    let st: Awaited<ReturnType<typeof checkDepositStatus>> | null = null
    try {
      st = await checkDepositStatus(order.payment_id)
    } catch (e) {
      console.error(`[ordering] retry status check failed order=${order.id} deposit=${order.payment_id}: ${(e as Error).message}`)
    }
    if (!st) {
      await sendWhatsApp(from, pickLang(
        `⏳ Impossible de vérifier votre paiement en cours. Réessayez "payer" dans 2 minutes.`,
        `⏳ Couldn't check your current payment. Send "pay" again in 2 minutes.`,
        lang,
      ))
      return ok()
    }
    if (!st.notFound) {
      if (st.status === 'COMPLETED') {
        // settleDeposit sends the payment confirmation itself.
        const { settleDeposit } = await import('@/lib/payments-settle')
        await settleDeposit(order.payment_id, st, 'status_poll')
        return ok()
      }
      if (st.status === 'FAILED' || st.status === 'REJECTED') {
        const { settleDeposit } = await import('@/lib/payments-settle')
        await settleDeposit(order.payment_id, st, 'status_poll')
        // Now 'failed' — fall through to a fresh deposit below.
      } else {
        await sendWhatsApp(from, pickLang(
          `⏳ Votre paiement précédent est toujours en cours. Validez la demande sur votre téléphone; si elle a expiré, envoyez "payer" dans 2 minutes.`,
          `⏳ Your previous payment is still being processed. Approve the prompt on your phone; if it expired, send "pay" again in 2 minutes.`,
          lang,
        ))
        return ok()
      }
    }
  }

  const rest = order.restaurants as unknown as { name?: string; city?: string } | null
  // initiateWhatsappPayment tells the customer the outcome either way.
  await initiateWhatsappPayment(
    from,
    order.id,
    customer.id,
    customer.phone,
    Number(order.total_price),
    rest?.name ?? '—',
    rest?.city ?? '',
    lang,
  )
  return ok()
}

// ── Public: handle a "commander" / "mes commandes" intent ────────────────────
export async function handleOrderCommand(
  from: string,
  phone: string,
  cmd: string,
  customer: OrderingCustomer,
  // Raw (original-case) message body. `cmd` is lower-cased for matching, but
  // free-text tails (e.g. an organizer's message to attendees) must keep their
  // casing, so those are captured from `body`. Defaults to `cmd` when omitted.
  body: string = cmd,
): Promise<NextResponse | null> {
  const lang = normalizeLang(customer.preferred_language)
  if (cmd === 'commander' || cmd === 'order' || cmd === 'commande') {
    const restaurants = await listRestaurantsForCity(customer.city)
    if (restaurants.length === 0) {
      await sendWhatsApp(from, pickLang('🚫 Aucun restaurant disponible pour le moment.', '🚫 No restaurants available right now.', lang))
      return ok()
    }
    const scoped = restaurants.some(r => r.city === customer.city) ? customer.city : null
    const msg = scoped
      ? buildRestaurantListMessage(restaurants, scoped, lang)
      : pickLang(
          `Aucun restaurant à ${customer.city}. Voici tous les restaurants:`,
          `No restaurants in ${customer.city}. Here are all:`,
          lang,
        ) + '\n\n' +
        buildRestaurantListMessage(restaurants, null, lang)

    const { error: upsertErr } = await supabaseAdmin.from('signup_sessions').upsert({
      phone,
      user_type: 'ordering',
      step: 1,
      data: { candidates: restaurants.map(r => ({ id: r.id, name: r.name })) } as unknown as Record<string, unknown>,
      expires_at: sessionExpiry(15),
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
      await sendWhatsApp(from, pickLang(
        `🎫 Aucun bon. Envoyez "bon CODE" pour en ajouter un (ex: bon BIENVENUE).`,
        `🎫 No vouchers. Send "voucher CODE" to add one (e.g. voucher BIENVENUE).`,
        lang,
      ))
      return ok()
    }
    const now = Date.now()
    const statusFr = { used: '✅ Utilisé', expired: '⏰ Expiré', inactive: '⚪ Inactif', available: '🟢 Disponible' }
    const statusEn = { used: '✅ Used',    expired: '⏰ Expired', inactive: '⚪ Inactive', available: '🟢 Available' }
    const labels = lang === 'en' ? statusEn : statusFr
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
      const status  = used ? labels.used
                    : expired ? labels.expired
                    : !v.is_active ? labels.inactive
                    : labels.available
      const scope = v.restaurants?.name ? ` · ${v.restaurants.name}` : ''
      return `${i + 1}. *${v.code}* ${value}${scope}\n   ${status}`
    }).filter(Boolean)

    const header = pickLang('Vos bons', 'Your vouchers', lang)
    await sendWhatsApp(from, `🎫 *${header}:*\n\n${lines.join('\n\n')}` + `\n\n` +
      pickLang(
        `💡 Envoyez 'commander' pour utiliser un bon lors de votre prochaine commande.`,
        `💡 Send 'order' to use a voucher on your next order.`, lang))
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
      await sendWhatsApp(from, pickLang(`❌ Code introuvable: ${code}`, `❌ Code not found: ${code}`, lang))
      return ok()
    }
    if (!v.is_active) {
      await sendWhatsApp(from, pickLang(`❌ Code désactivé`, `❌ Code deactivated`, lang))
      return ok()
    }
    if (v.expires_at && new Date(v.expires_at).getTime() < Date.now()) {
      await sendWhatsApp(from, pickLang(`❌ Code expiré`, `❌ Code expired`, lang))
      return ok()
    }
    if (v.max_uses != null && v.max_uses > 0 && (v.current_uses ?? 0) >= v.max_uses) {
      await sendWhatsApp(from, pickLang(`❌ Code épuisé`, `❌ Code fully used`, lang))
      return ok()
    }
    const { data: prior } = await supabaseAdmin
      .from('customer_vouchers').select('id')
      .eq('customer_id', customer.id).eq('voucher_id', v.id)
    const limit = (v.per_customer_max ?? 1)
    if (limit > 0 && (prior?.length ?? 0) >= limit) {
      await sendWhatsApp(from, pickLang(`Déjà réclamé: ${code}`, `Already claimed: ${code}`, lang))
      return ok()
    }
    const { data: inserted, error: insErr } = await supabaseAdmin
      .from('customer_vouchers').insert({ customer_id: customer.id, voucher_id: v.id })
      .select('id').single()
    if (insErr) {
      console.error('[whatsapp] voucher claim failed:', insErr.message)
      await sendWhatsApp(from, pickLang(`⚠️ Erreur: ${insErr.message}`, `⚠️ Error: ${insErr.message}`, lang))
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
    await sendWhatsApp(from, pickLang(
      `🎫 Code *${code}* ajouté (${value})!\n\nUtilisez-le à votre prochaine commande.`,
      `🎫 Voucher *${code}* added (${value})!\n\nUse it on your next order.`,
      lang,
    ))
    return ok()
  }

  if (cmd === 'mes commandes' || cmd === 'my orders') {
    const { data } = await supabaseAdmin
      .from('orders')
      .select('id, status, total_price, created_at, order_type, payment_status, items, restaurants(name, prep_time_min, prep_time_max)')
      .eq('customer_id', customer.id)
      .order('created_at', { ascending: false })
      .limit(20)

    if (!data || data.length === 0) {
      await sendWhatsApp(from, pickLang(
        `📦 Aucune commande pour le moment.\n\n💡 Envoyez 'commander' pour en passer une!`,
        `📦 No orders yet.\n\n💡 Send 'order' to place one!`,
        lang,
      ))
      return ok()
    }

    const en = lang === 'en'
    type OrderRow = typeof data[number]
    type OrderItem = { name: string; quantity: number; price: number }
    const restOf  = (o: OrderRow) => (o.restaurants as unknown as { name: string; prep_time_min: number | null; prep_time_max: number | null } | null)
    const restName = (o: OrderRow) => restOf(o)?.name ?? '—'

    // Full status line for active orders — emoji + label + what-to-expect.
    const statusDesc = (status: string, rest: string): string => {
      switch (status) {
        case 'pending':   return en ? '⏳ Pending — waiting for restaurant to confirm'  : '⏳ En attente — en attente de confirmation du restaurant'
        case 'confirmed': return en ? '✅ Confirmed — restaurant accepted your order'   : '✅ Confirmée — le restaurant a accepté votre commande'
        case 'preparing': return en ? '🍳 Preparing — your food is being prepared'      : '🍳 En préparation — votre plat est en cours de préparation'
        case 'ready':     return en ? `🎉 Ready — ready for pickup at ${rest}!`          : `🎉 Prête — prête à récupérer chez ${rest}!`
        case 'delivered':
        case 'completed': return en ? '📦 Picked up — enjoy your meal!'                 : '📦 Récupérée — bon appétit!'
        case 'cancelled': return en ? '❌ Cancelled'                                     : '❌ Annulée'
        default:          return status
      }
    }
    // Compact status pill for the recent-orders one-liners.
    const statusShort = (status: string): string => {
      switch (status) {
        case 'pending':   return en ? '⏳ Pending'   : '⏳ En attente'
        case 'confirmed': return en ? '✅ Confirmed' : '✅ Confirmée'
        case 'preparing': return en ? '🍳 Preparing' : '🍳 En préparation'
        case 'ready':     return en ? '🎉 Ready'     : '🎉 Prête'
        case 'delivered':
        case 'completed': return en ? '📦 Picked up' : '📦 Récupérée'
        case 'cancelled': return en ? '❌ Cancelled' : '❌ Annulée'
        default:          return status
      }
    }
    // Payment pill — only when payment is actually relevant (paid orders).
    const paymentPill = (o: OrderRow): string => {
      if (o.order_type !== 'paid_order') return ''
      if (o.payment_status === 'paid')     return en ? '💰 Paid'           : '💰 Payé'
      if (o.payment_status === 'refunded') return en ? '↩️ Refunded'       : '↩️ Remboursé'
      return en ? '⏳ Payment pending' : '⏳ Paiement en attente'
    }
    const itemsLine = (o: OrderRow): string => {
      const items = (o.items as unknown as OrderItem[] | null) ?? []
      const summary = items.length ? items.map(it => `${it.quantity}× ${it.name}`).join(', ') : ''
      const price = `${Number(o.total_price).toLocaleString()} FCFA`
      return summary ? `${summary} — ${price}` : price
    }

    const ACTIVE = new Set(['pending', 'confirmed', 'preparing', 'ready'])
    const active = data.filter(o => ACTIVE.has(o.status))
    const recent = data.filter(o => !ACTIVE.has(o.status)).slice(0, 3)

    let hasUnpaid = false
    const activeBlocks = active.map(o => {
      const rest = restName(o)
      const block = [
        `#${last4(o.id)} — ${rest}`,
        itemsLine(o),
        statusDesc(o.status, rest),
      ]
      // Prep-time estimate once the kitchen is engaged.
      if (o.status === 'confirmed' || o.status === 'preparing') {
        const r = restOf(o)
        const label = formatPrepTime(r?.prep_time_min, r?.prep_time_max)
        if (label) block.push(`🕐 ${en ? 'Ready in' : 'Prête dans'} ~${label}`)
      }
      const pill = paymentPill(o)
      if (pill) block.push(pill)
      if (o.order_type === 'paid_order' && (o.payment_status === 'pending' || o.payment_status === 'failed')) {
        hasUnpaid = true
      }
      return block.join('\n')
    })

    const recentLines = recent.map(o => {
      const date = new Date(o.created_at).toLocaleDateString(en ? 'en-US' : 'fr-FR', { day: 'numeric', month: 'short' })
      return `#${last4(o.id)} — ${restName(o)} — ${statusShort(o.status)} — ${date}`
    })

    const parts: string[] = []
    if (activeBlocks.length) {
      parts.push(`📦 *${en ? 'Your active orders' : 'Vos commandes en cours'}:*`, '', activeBlocks.join('\n\n'))
    } else {
      parts.push(`📦 ${en ? 'No active orders.' : 'Aucune commande en cours.'}`)
    }
    if (recentLines.length) {
      parts.push('', `📜 *${en ? 'Recent orders' : 'Commandes récentes'}:*`, recentLines.join('\n'))
    }
    if (hasUnpaid) {
      parts.push('', en ? '💳 Send "pay" to retry payment.' : '💳 Envoyez "payer" pour réessayer le paiement.')
    }
    parts.push('', en ? `💡 Send 'order' to place a new order.` : `💡 Envoyez 'commander' pour passer une nouvelle commande.`)

    await sendWhatsApp(from, parts.join('\n'))
    return ok()
  }

  // ── Event reservations ────────────────────────────────────────────────────
  // "mes reservations" / "my reservations" → show upcoming + recent
  // reservations with status + payment pill. Cancellations stay listed so
  // customers can see what they cancelled in WhatsApp scrollback.
  if (cmd === 'mes reservations' || cmd === 'mes réservations' || cmd === 'my reservations') {
    const { data } = await supabaseAdmin
      .from('event_reservations')
      .select(`id, quantity, total_price, payment_status, reservation_status, reservation_code, created_at, events(id, title, ${EVENT_DATE_COLUMNS}, venue, event_status)`)
      .eq('customer_id', customer.id)
      .order('created_at', { ascending: false })
      .limit(10)

    if (!data || data.length === 0) {
      await sendWhatsApp(from, pickLang(
        `🎟 Aucune réservation. Envoyez "evenements" pour parcourir.`,
        `🎟 No reservations. Send "events" to browse.`,
        lang,
      ))
      return ok()
    }
    const statusLabel: Record<string, string> = lang === 'en' ? {
      confirmed: '✅ Confirmed',
      cancelled: '❌ Cancelled',
      attended:  '🎉 Attended',
    } : {
      confirmed: '✅ Confirmée',
      cancelled: '❌ Annulée',
      attended:  '🎉 Participée',
    }
    const payLabel: Record<string, string> = lang === 'en' ? {
      paid:         '💰 Paid',
      pending:      '⏳ Payment pending',
      failed:       '❌ Payment failed',
      not_required: '📋 Free',
    } : {
      paid:         '💰 Payé',
      pending:      '⏳ Paiement en attente',
      failed:       '❌ Paiement échoué',
      not_required: '📋 Gratuit',
    }
    const lines = data.map((r, i) => {
      const ev = r.events as unknown as { title: string; date: string; end_date: string | null; venue: string | null } | null
      const dateStr = ev ? formatEventDates(ev, lang, 'compact') : ''
      const pay   = payLabel[r.payment_status ?? 'not_required'] ?? ''
      const stat  = statusLabel[r.reservation_status] ?? r.reservation_status
      const codeStr = r.reservation_code ? ` · #${r.reservation_code}` : ''
      return `${i + 1}. *${ev?.title ?? '—'}* (${dateStr})${codeStr}\n   🎟 ${r.quantity} place(s)${r.total_price > 0 ? ` · ${Number(r.total_price).toLocaleString()} FCFA` : ''}\n   ${stat}${pay ? ` · ${pay}` : ''}`
    })

    // Seed a reservations_browse session so "annuler reservation N" can
    // resolve the list number back to the right id without a follow-up
    // round-trip. 15-minute TTL — same as the spec.
    const { error: sessErr } = await supabaseAdmin.from('signup_sessions').upsert({
      phone, user_type: 'reservations_browse', step: 1,
      data: { reservation_ids: data.map(d => d.id) },
      expires_at: sessionExpiry(15),
    })
    if (sessErr) return sessionSaveFailed(from, 'reservations_browse', sessErr, lang)

    await sendWhatsApp(from,
      `${pickLang('🎟 *Vos réservations:*', '🎟 *Your reservations:*', lang)}\n\n${lines.join('\n\n')}\n\n` +
      pickLang(`Envoyez "annuler reservation N" pour annuler`, `Send "cancel reservation N" to cancel`, lang))
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
      await sendWhatsApp(from, pickLang(
        `❌ Aucune réservation #${n}. Envoyez "mes reservations" d'abord.`,
        `❌ No reservation #${n}. Send "my reservations" first.`,
        lang,
      ))
      return ok()
    }
    const resvId = ids[n - 1]
    // Server-route call would be cleaner but we're already in the same
    // process with service-role access. Inline the cancel logic so the
    // organizer ping reuses sendWhatsApp.
    const { data: r } = await supabaseAdmin
      .from('event_reservations')
      .select('id, event_id, customer_id, customer_name, customer_phone, quantity, tier_id, payment_status, reservation_status, total_price, reservation_code')
      .eq('id', resvId).maybeSingle()
    if (!r || r.customer_id !== customer.id) {
      await sendWhatsApp(from, pickLang(`❌ Réservation introuvable.`, `❌ Reservation not found.`, lang))
      return ok()
    }
    if (r.reservation_status === 'cancelled') {
      await sendWhatsApp(from, pickLang(`Déjà annulée.`, `Already cancelled.`, lang))
      return ok()
    }
    // Same rule as the web: a paid ticket is cancelled by the organizer.
    if (r.payment_status === 'paid') {
      await sendWhatsApp(from, pickLang(
        `💰 Contactez l'organisateur pour annuler un billet payé.`,
        `💰 Contact the organiser to cancel a paid ticket.`,
        lang,
      ))
      return ok()
    }
    if (r.payment_status === 'pending') {
      await sendWhatsApp(from, pickLang(
        `⏳ Paiement en cours — réessayez dans quelques minutes.`,
        `⏳ Payment in progress — try again in a few minutes.`,
        lang,
      ))
      return ok()
    }
    const { data: ev } = await supabaseAdmin
      .from('events').select(`id, title, ${EVENT_DATE_COLUMNS}, organizer_id, whatsapp`).eq('id', r.event_id).maybeSingle()
    if (!ev) {
      await sendWhatsApp(from, pickLang(`❌ Événement introuvable.`, `❌ Event not found.`, lang))
      return ok()
    }
    // Only the call that actually moves the row releases the seats (event
    // total and tier).
    let closed
    try {
      closed = await closeReservation(r.id, 'cancelled')
    } catch (e) {
      console.error('[whatsapp/cancel] failed:', (e as Error).message)
      await sendWhatsApp(from, pickLang(`⚠️ Erreur — réessayez.`, `⚠️ Error — please try again.`, lang))
      return ok()
    }
    if (!closed) {
      await sendWhatsApp(from, pickLang(`Cette réservation ne peut plus être annulée.`, `This reservation can no longer be cancelled.`, lang))
      return ok()
    }
    await writeAudit({
      action:          'event_reservation_cancelled',
      targetType:      'event_reservation',
      targetId:        r.id,
      performedBy:     customer.id,
      performedByType: 'customer',
      previousData:    { reservation_status: r.reservation_status, payment_status: r.payment_status },
      metadata:        { event_id: ev.id, quantity: r.quantity, needs_refund: r.payment_status === 'paid', via: 'whatsapp' },
    })

    const cancelCodeStr = r.reservation_code ? ` #${r.reservation_code}` : ''
    await sendWhatsApp(from, pickLang(`✅ Réservation${cancelCodeStr} annulée.`, `✅ Reservation${cancelCodeStr} cancelled.`, lang))

    // Organizer ping — reuse the customer-cancel pathway from the API.
    let organizerPhone: string | null = null
    if (ev.organizer_id) {
      const { data: o } = await supabaseAdmin.from('customers').select('phone').eq('id', ev.organizer_id).maybeSingle()
      organizerPhone = o?.phone ?? null
    }
    if (!organizerPhone && ev.whatsapp) organizerPhone = ev.whatsapp
    if (organizerPhone) {
      const orgLang = await getLangByPhone(organizerPhone)
      const dateStr = formatEventDates(ev, orgLang, 'message')
      await sendWhatsApp(organizerPhone, [
        pickLang(`❌ *Réservation${cancelCodeStr} annulée*`, `❌ *Reservation${cancelCodeStr} cancelled*`, orgLang),
        ``,
        `🎉 ${ev.title}`,
        `📅 ${dateStr}`,
        `👤 ${r.customer_name}`,
        `📱 ${r.customer_phone}`,
        `🎟 ${r.quantity} ${pickLang('place(s)', 'spot(s)', orgLang)}`,
      ].join('\n'), { context: 'event_reservation', relatedId: ev.id }).catch(() => null)
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
      .select(`id, title, ${EVENT_DATE_COLUMNS}, ticket_price, payment_enabled, city`)
      .eq('is_active', true).eq('city', customer.city)
      .gte('effective_end_date', today)
      .order('date', { ascending: true }).limit(10)
    let cityScope = customer.city
    if (!scoped || scoped.length === 0) {
      const { data: any } = await supabaseAdmin
        .from('events')
        .select(`id, title, ${EVENT_DATE_COLUMNS}, ticket_price, payment_enabled, city`)
        .eq('is_active', true)
        .gte('effective_end_date', today)
        .order('date', { ascending: true }).limit(10)
      scoped = any ?? []
      cityScope = ''
    }
    if (!scoped || scoped.length === 0) {
      await sendWhatsApp(from, pickLang(`🎉 Aucun événement à venir.`, `🎉 No upcoming events.`, lang))
      return ok()
    }
    const header = cityScope
      ? pickLang(`🎉 *Événements à ${cityScope}:*`, `🎉 *Events in ${cityScope}:*`, lang)
      : pickLang(`🎉 *Événements à venir:*`, `🎉 *Upcoming events:*`, lang)
    const lines = scoped.map((e, i) => {
      const when = formatEventWhen(e, lang, 'list')
      const price = !e.ticket_price || e.ticket_price <= 0
        ? pickLang('Gratuit', 'Free', lang)
        : `${Number(e.ticket_price).toLocaleString()} FCFA`
      return `${i + 1}. *${e.title}* — ${when} — ${price}`
    })

    const { error: sessErr } = await supabaseAdmin.from('signup_sessions').upsert({
      phone, user_type: 'event_browse', step: 1,
      data: { event_ids: scoped.map(e => e.id) },
      expires_at: sessionExpiry(15),
    })
    if (sessErr) return sessionSaveFailed(from, 'event_browse', sessErr, lang)

    await sendWhatsApp(from,
      `${header}\n\n${lines.join('\n')}\n\n` +
      pickLang(
        `💡 Envoyez le numéro d'un événement pour voir les détails, ou 'abonner' pour recevoir les alertes.`,
        `💡 Send an event number for details, or 'subscribe' for event alerts.`, lang))
    return ok()
  }

  // "reservations XXXX" — organizer-side read-only listing by EVENT short
  // code. Requires the plural so it doesn't collide with the singular
  // "reservation CODE" (single-reservation details) added below.
  const reservationsMatch = cmd.match(/^reservations\s+([0-9a-f]{4})$/i)
  if (reservationsMatch) {
    const code4 = reservationsMatch[1].toLowerCase()
    // Constrain to events the caller organizes.
    const { data: candidates } = await supabaseAdmin
      .from('events').select('id, title, date, organizer_id, whatsapp')
      .or(organizerScope(customer.id)).limit(50)
    const event = (candidates ?? []).find(e => e.id.replace(/-/g, '').toLowerCase().endsWith(code4))
    if (!event) {
      await sendWhatsApp(from, pickLang(
        `❌ Événement #${code4.toUpperCase()} introuvable parmi vos événements.`,
        `❌ Event #${code4.toUpperCase()} not found in your events.`,
        lang,
      ))
      return ok()
    }
    const { data: resvs } = await supabaseAdmin
      .from('event_reservations')
      .select('customer_name, customer_phone, quantity, payment_status, reservation_status, reservation_code')
      .eq('event_id', event.id)
      .order('created_at', { ascending: false })
      .limit(20)
    if (!resvs || resvs.length === 0) {
      await sendWhatsApp(from, `📋 *${event.title}*\n\n${pickLang('Aucune réservation pour le moment.', 'No reservations yet.', lang)}`)
      return ok()
    }
    const lines = resvs.map((r, i) => {
      const pay = r.payment_status === 'paid' ? pickLang('💰 Payé', '💰 Paid', lang)
        : r.payment_status === 'pending' ? pickLang('⏳ En attente', '⏳ Pending', lang)
        : r.payment_status === 'failed' ? pickLang('❌ Échec', '❌ Failed', lang)
        : pickLang('📋 Gratuit', '📋 Free', lang)
      const stat = r.reservation_status === 'cancelled' ? pickLang(' · ❌ Annulée', ' · ❌ Cancelled', lang)
        : r.reservation_status === 'attended' ? pickLang(' · 🎉 Participée', ' · 🎉 Attended', lang)
        : ''
      const code = r.reservation_code ? `*#${r.reservation_code}* — ` : ''
      return `${i + 1}. ${code}${r.customer_name} — ${pickLang(`${r.quantity} place(s)`, `${r.quantity} spot(s)`, lang)} — ${pay}${stat}\n   📱 ${r.customer_phone}`
    })
    await sendWhatsApp(from,
      `${pickLang(`📋 *Réservations — ${event.title}:*`, `📋 *Reservations — ${event.title}:*`, lang)}\n\n${lines.join('\n\n')}\n\n` +
      pickLang(`✅ Pointer une présence: envoyez "present CODE" (ex: present A3F7).`, `✅ Check someone in: send "present CODE" (e.g. present A3F7).`, lang) + '\n' +
      pickLang(`Ou gérez tout sur le site:`, `Or manage everything on the site:`, lang) + `\n${BASE_URL}/account?tab=events`)
    return ok()
  }

  // "modifier XXXX" / "edit XXXX" — deep-link the organizer to the web edit
  // form. Rich editing (fields + photo) lives on the site; the bot just
  // routes them there. Scoped to the caller's own events.
  const editMatch = cmd.match(/^(?:modifier|edit)\s+([0-9a-f]{4})$/i)
  if (editMatch) {
    const code4 = editMatch[1].toLowerCase()
    const { data: candidates } = await supabaseAdmin
      .from('events').select('id, title, organizer_id').or(organizerScope(customer.id)).limit(50)
    const event = (candidates ?? []).find(e => e.id.replace(/-/g, '').toLowerCase().endsWith(code4))
    if (!event) {
      await sendWhatsApp(from, pickLang(
        `❌ Événement #${code4.toUpperCase()} introuvable dans vos événements.`,
        `❌ Event #${code4.toUpperCase()} not found in your events.`, lang))
      return ok()
    }
    await sendWhatsApp(from,
      `✏️ *${event.title}*\n\n` +
      pickLang('Modifiez votre événement ici', 'Edit your event here', lang) +
      `:\n${BASE_URL}/account?tab=events`)
    return ok()
  }

  // "message evenement XXXX <text>" / "message event XXXX <text>" — free,
  // targeted send to everyone who reserved for the event. The text is
  // captured from the raw body so its casing survives (cmd is lower-cased).
  // Rate-limited to 2/event/day inside sendEventMessage.
  const msgEventMatch = body.trim().match(/^message\s+(?:evenement|événement|event)\s+([0-9a-f]{4})\s+([\s\S]+)$/i)
  if (msgEventMatch) {
    const code4 = msgEventMatch[1].toLowerCase()
    const text  = msgEventMatch[2].trim()
    const { data: candidates } = await supabaseAdmin
      .from('events')
      .select(`id, title, ${EVENT_DATE_COLUMNS}, venue, organizer_id, organizer_name`)
      .or(organizerScope(customer.id)).limit(50)
    const event = (candidates ?? []).find(e => e.id.replace(/-/g, '').toLowerCase().endsWith(code4))
    if (!event) {
      await sendWhatsApp(from, pickLang(
        `❌ Événement #${code4.toUpperCase()} introuvable dans vos événements.`,
        `❌ Event #${code4.toUpperCase()} not found in your events.`, lang))
      return ok()
    }
    const result = await sendEventMessage(event, text, customer.id, 'customer')
    if (!result.ok) {
      await sendWhatsApp(from, result.rate_limited
        ? pickLang('⏳ Limite atteinte (2 messages/jour pour cet événement).', '⏳ Limit reached (2 messages/day for this event).', lang)
        : pickLang('❌ Message invalide (max 1000 caractères).', '❌ Invalid message (max 1000 chars).', lang))
      return ok()
    }
    await sendWhatsApp(from, pickLang(
      `📨 Message envoyé à ${result.sent_count} inscrit(s).`,
      `📨 Message sent to ${result.sent_count} attendee(s).`, lang))
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
      .or(organizerScope(customer.id)).limit(50)
    const event = (candidates ?? []).find(e => e.id.replace(/-/g, '').toLowerCase().endsWith(code4))
    if (!event) {
      await sendWhatsApp(from, pickLang(`❌ Événement #${code4.toUpperCase()} introuvable.`, `❌ Event #${code4.toUpperCase()} not found.`, lang))
      return ok()
    }
    const { data: tiers } = await supabaseAdmin
      .from('event_ticket_tiers')
      .select('name, price, max_quantity, sold_count, is_active')
      .eq('event_id', event.id)
      .order('sort_order', { ascending: true })
    if (!tiers || tiers.length === 0) {
      await sendWhatsApp(from, `🎫 *${event.title}*\n\n${pickLang(`Aucun tarif.\nAjoutez-en sur ${BASE_URL}/account.`, `No tiers.\nAdd some at ${BASE_URL}/account.`, lang)}`)
      return ok()
    }
    const lines = tiers.map((t, i) => {
      const cap = t.max_quantity > 0 ? `${t.sold_count}/${t.max_quantity}` : `${t.sold_count}`
      const inactive = t.is_active ? '' : pickLang(' (inactif)', ' (inactive)', lang)
      const priceLine = t.price === 0 ? pickLang('Gratuit', 'Free', lang) : `${t.price.toLocaleString()} FCFA`
      return `${i + 1}. ${t.name} — ${priceLine} · ${pickLang(`${cap} vendus`, `${cap} sold`, lang)}${inactive}`
    })
    await sendWhatsApp(from, `${pickLang(`🎫 *Tarifs — ${event.title}:*`, `🎫 *Tiers — ${event.title}:*`, lang)}\n\n${lines.join('\n')}`)
    return ok()
  }

  // "ajouter tarif XXXX name price max" — organizer shortcut to create
  // a new tier from chat. Spaces in the tier name must be replaced with
  // underscores ("Plein_tarif") for the parser to work; the underscore
  // is rewritten to a space before insert.
  const addTarifMatch = cmd.match(/^(?:ajouter\s+tarif|add\s+tier)\s+([0-9a-f]{4})\s+(\S+)\s+(\d+)(?:\s+(\d+))?$/i)
  if (addTarifMatch) {
    const code4 = addTarifMatch[1].toLowerCase()
    const rawName = addTarifMatch[2].replace(/_+/g, ' ').trim()
    const price = Number.parseInt(addTarifMatch[3], 10)
    const maxQty = addTarifMatch[4] ? Number.parseInt(addTarifMatch[4], 10) : 0

    const { data: candidates } = await supabaseAdmin
      .from('events').select('id, title, organizer_id')
      .or(organizerScope(customer.id)).limit(50)
    const event = (candidates ?? []).find(e => e.id.replace(/-/g, '').toLowerCase().endsWith(code4))
    if (!event) {
      await sendWhatsApp(from, pickLang(`❌ Événement #${code4.toUpperCase()} introuvable.`, `❌ Event #${code4.toUpperCase()} not found.`, lang))
      return ok()
    }
    if (!rawName || !Number.isFinite(price) || price < 0) {
      await sendWhatsApp(from, pickLang(`❌ Format: "ajouter tarif XXXX nom prix max"`, `❌ Format: "add tier XXXX name price max"`, lang))
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
      await sendWhatsApp(from, pickLang(`❌ Erreur. Réessayez.`, `❌ Error. Retry.`, lang))
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

    await sendWhatsApp(from, pickLang(
      `✅ Tarif *${inserted.name}* ajouté à *${event.title}* — ${price.toLocaleString()} FCFA.`,
      `✅ Tier *${inserted.name}* added to *${event.title}* — ${price.toLocaleString()} FCFA.`,
      lang,
    ))
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
      .or(organizerScope(customer.id)).limit(50)
    const event = (candidates ?? []).find(e => e.id.replace(/-/g, '').toLowerCase().endsWith(code4))
    if (!event) {
      await sendWhatsApp(from, pickLang(`❌ Événement #${code4.toUpperCase()} introuvable.`, `❌ Event #${code4.toUpperCase()} not found.`, lang))
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
        ? pickLang(`🔓 Réservations ouvertes pour *${event.title}*.`, `🔓 Reservations opened for *${event.title}*.`, lang)
        : pickLang(`🔒 Réservations fermées pour *${event.title}*.`, `🔒 Reservations closed for *${event.title}*.`, lang))
    return ok()
  }

  // "confirmer reservation XXXX" / "rejeter reservation XXXX" — organizer
  // confirms / rejects a pending reservation by its 4-char ID suffix.
  // Customer notification is handled inside the API handlers via the
  // shared sendWhatsApp helper, so we just delegate over fetch.
  // Tolerant on purpose: the organizer may type the accented "réservation",
  // drop the noun entirely, or paste the code with its leading '#'.
  const reservDecisionMatch = cmd.match(
    /^(confirmer|confirme|valider|rejeter|refuser|confirm|reject|decline)\s+(?:r[ée]servations?\s+)?#?\s*([a-z0-9]{4,6})$/i,
  )
  if (reservDecisionMatch) {
    const verb  = reservDecisionMatch[1].toLowerCase()
    const code4 = reservDecisionMatch[2]
    const action = ['confirmer', 'confirme', 'valider', 'confirm'].includes(verb) ? 'confirm' : 'reject'
    console.log('[whatsapp] reservation decision: verb=%s action=%s code=%s from=%s customer=%s',
      verb, action, code4, from, customer.id)

    // Resolve the reservation by its code (or legacy UUID suffix), scoped to
    // this organizer's events (by account, or by the event's WhatsApp number).
    const match = await resolveReservationByCode(customer.id, code4, customer.phone)
    if (!match) {
      console.warn('[whatsapp] reservation %s not found for organizer %s', code4, customer.id)
      await sendWhatsApp(from, pickLang(
        `❌ Réservation #${code4.toUpperCase()} introuvable parmi vos événements.\nEnvoyez "mes evenements" puis "reservations CODE" pour la liste.`,
        `❌ Reservation #${code4.toUpperCase()} not found in your events.\nSend "my events" then "reservations CODE" for the list.`,
        lang))
      return ok()
    }
    if (match.reservation_status === 'cancelled' || match.reservation_status === 'rejected') {
      const shownClosed = match.reservation_code ?? code4.toUpperCase()
      await sendWhatsApp(from, pickLang(
        `❌ Réservation #${shownClosed} déjà clôturée (${match.reservation_status}).`,
        `❌ Reservation #${shownClosed} is already closed (${match.reservation_status}).`, lang))
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
        const custLang = await getLangByPhone(r.customer_phone)
        const codeSuffix = match.reservation_code ? `\n🎫 #${match.reservation_code}` : ''
        await sendWhatsApp(r.customer_phone, pickLang(
          `✅ *Votre réservation est confirmée!*\n🎉 ${ev?.title ?? ''}\n🎟 ${r.quantity} place(s)${codeSuffix}`,
          `✅ *Your reservation is confirmed!*\n🎉 ${ev?.title ?? ''}\n🎟 ${r.quantity} spot(s)${codeSuffix}`,
          custLang,
        )).catch(() => null)
      }
      const shownCode = match.reservation_code ?? code4.toUpperCase()
      console.log('[whatsapp] reservation %s confirmed by organizer %s', match.id, customer.id)
      await sendWhatsApp(from, pickLang(`✅ Réservation #${shownCode} confirmée.`, `✅ Reservation #${shownCode} confirmed.`, lang))
    } else {
      // Reject — also release seats (event total and tier, exactly once).
      const { data: r } = await supabaseAdmin
        .from('event_reservations').select('quantity, customer_phone, event_id, events!event_reservations_event_id_fkey(title)').eq('id', match.id).maybeSingle()
      let closed = null
      try {
        closed = r ? await closeReservation(match.id, 'rejected') : null
      } catch (e) {
        console.error('[whatsapp/reject] failed:', (e as Error).message)
      }
      if (!closed) {
        await sendWhatsApp(from, pickLang(
          `⚠️ Impossible de refuser cette réservation (déjà clôturée ou paiement en cours).`,
          `⚠️ Couldn't reject this reservation (already closed or payment in progress).`,
          lang,
        ))
        return ok()
      }
      if (r) {
        const ev = r.events as unknown as { title: string } | null
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
          const custLang = await getLangByPhone(r.customer_phone)
          const codeStr = match.reservation_code ? ` #${match.reservation_code}` : ''
          await sendWhatsApp(r.customer_phone, pickLang(
            `❌ *Votre réservation${codeStr} pour ${ev?.title ?? ''} a été refusée.*`,
            `❌ *Your reservation${codeStr} for ${ev?.title ?? ''} has been declined.*`,
            custLang,
          )).catch(() => null)
        }
      }
      const shownRejectCode = match.reservation_code ?? code4.toUpperCase()
      console.log('[whatsapp] reservation %s rejected by organizer %s', match.id, customer.id)
      await sendWhatsApp(from, pickLang(`❌ Réservation #${shownRejectCode} rejetée.`, `❌ Reservation #${shownRejectCode} rejected.`, lang))
    }
    return ok()
  }

  // "present CODE" / "présent CODE" / "checkin CODE" — organizer marks a
  // reservation as attended (door check-in) by its short code.
  const presentMatch = cmd.match(/^(?:present|présent|checkin|check-in|pointer)\s+#?\s*([a-z0-9]{4,6})$/i)
  if (presentMatch) {
    const code = presentMatch[1]
    const match = await resolveReservationByCode(customer.id, code, customer.phone)
    if (!match) {
      await sendWhatsApp(from, pickLang(`❌ Réservation #${code.toUpperCase()} introuvable.`, `❌ Reservation #${code.toUpperCase()} not found.`, lang))
      return ok()
    }
    const shown = match.reservation_code ?? code.toUpperCase()
    if (match.reservation_status === 'cancelled' || match.reservation_status === 'rejected') {
      await sendWhatsApp(from, pickLang(
        `❌ Réservation #${shown} annulée — impossible de pointer.`,
        `❌ Reservation #${shown} was cancelled — can't check in.`, lang))
      return ok()
    }
    if (match.reservation_status === 'attended') {
      await sendWhatsApp(from, pickLang(
        `✅ #${shown} déjà pointé (${match.customer_name}).`,
        `✅ #${shown} already checked in (${match.customer_name}).`, lang))
      return ok()
    }
    await supabaseAdmin
      .from('event_reservations')
      .update({ reservation_status: 'attended', updated_at: new Date().toISOString() })
      .eq('id', match.id)
    const { writeAudit } = await import('@/lib/audit')
    await writeAudit({
      action:          'event_reservation_attended',
      targetType:      'event_reservation',
      targetId:        match.id,
      performedBy:     customer.id,
      performedByType: 'organizer',
      previousData:    { reservation_status: match.reservation_status },
      metadata:        { event_id: match.event_id, quantity: match.quantity, via: 'whatsapp' },
    })
    await sendWhatsApp(from, pickLang(
      `🎉 *Présence enregistrée!*\n#${shown} — ${match.customer_name} (${match.quantity} place(s))`,
      `🎉 *Checked in!*\n#${shown} — ${match.customer_name} (${match.quantity} spot(s))`, lang))
    return ok()
  }

  // "reservation CODE" (singular) — organizer looks up one reservation's
  // details by its short code. (Plural "reservations XXXX" lists an event.)
  const reservLookupMatch = cmd.match(/^r[ée]servation\s+#?\s*([a-z0-9]{4,6})$/i)
  if (reservLookupMatch) {
    const code = reservLookupMatch[1]
    const match = await resolveReservationByCode(customer.id, code, customer.phone)
    if (!match) {
      await sendWhatsApp(from, pickLang(`❌ Réservation #${code.toUpperCase()} introuvable.`, `❌ Reservation #${code.toUpperCase()} not found.`, lang))
      return ok()
    }
    const shown = match.reservation_code ?? code.toUpperCase()
    const done = ['attended', 'cancelled', 'rejected'].includes(match.reservation_status)
    const statLabel = match.reservation_status === 'attended' ? pickLang('🎉 Présent', '🎉 Attended', lang)
      : match.reservation_status === 'cancelled' ? pickLang('❌ Annulée', '❌ Cancelled', lang)
      : match.reservation_status === 'rejected' ? pickLang('❌ Refusée', '❌ Rejected', lang)
      : match.reservation_status === 'pending' ? pickLang('⏳ En attente', '⏳ Pending', lang)
      : pickLang('✅ Confirmée', '✅ Confirmed', lang)
    await sendWhatsApp(from, [
      pickLang(`🎟 *Réservation #${shown}*`, `🎟 *Reservation #${shown}*`, lang),
      `🎉 ${match.events?.title ?? ''}`,
      `👤 ${match.customer_name}`,
      `📱 ${match.customer_phone}`,
      `🎫 ${match.quantity} ${pickLang('place(s)', 'spot(s)', lang)}`,
      statLabel,
      done ? '' : pickLang(`Envoyez "present ${shown}" pour pointer.`, `Send "present ${shown}" to check in.`, lang),
    ].filter(Boolean).join('\n'))
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
      .gte('effective_end_date', new Date().toISOString().slice(0, 10))
      .order('date', { ascending: true }).limit(50)
    const event = (candidates ?? []).find(e => e.id.replace(/-/g, '').toLowerCase().endsWith(code4))
    if (!event) {
      await sendWhatsApp(from, pickLang(`❌ Événement #${code4.toUpperCase()} introuvable.`, `❌ Event #${code4.toUpperCase()} not found.`, lang))
      return ok()
    }
    if (event.reservations_open === false) {
      await sendWhatsApp(from, pickLang(
        `🔒 Les réservations pour *${event.title}* sont fermées.`,
        `🔒 Reservations for *${event.title}* are closed.`,
        lang,
      ))
      return ok()
    }
    return startReserveFlow(from, phone, event.id, lang, customer)
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
        pickLang(
          `⭐ Notez ${rest?.name ?? 'votre dernier restaurant'} ici:`,
          `⭐ Rate ${rest?.name ?? 'your last restaurant'} here:`,
          lang,
        ) + `\n${BASE_URL}/restaurant/${lastDelivered.restaurant_id}#rate`)
    } else {
      await sendWhatsApp(from, pickLang(
        `🍽️ Aucune commande livrée pour le moment. Commandez d'abord, puis revenez pour noter.`,
        `🍽️ No delivered orders yet. Order first, then come back to rate.`,
        lang,
      ))
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
    const lines: string[] = [pickLang(`🚩 *Signaler un problème*`, `🚩 *Report an issue*`, lang), '']
    if (lastOrder?.restaurant_id) {
      const r = lastOrder.restaurants as unknown as { name: string } | null
      lines.push(`🏪 ${r?.name ?? 'Restaurant'}: ${BASE_URL}/restaurant/${lastOrder.restaurant_id}`)
    }
    if (lastResv?.event_id) {
      const e = lastResv.events as unknown as { title: string } | null
      lines.push(`🎉 ${e?.title ?? pickLang('Événement', 'Event', lang)}: ${BASE_URL}/events/${lastResv.event_id}`)
    }
    if (lines.length === 2) {
      lines.push(pickLang(
        `Ouvrez la page d'un restaurant ou d'un événement et cliquez "🚩 Signaler".`,
        `Open a restaurant or event page and click "🚩 Report".`,
        lang,
      ))
    } else {
      lines.push('', pickLang(`Cliquez "🚩 Signaler" en bas de la page.`, `Click "🚩 Report" at the bottom.`, lang))
    }
    await sendWhatsApp(from, lines.join('\n'))
    return ok()
  }

  // "publier" / "publish" → deep-link to the in-app submission form. The
  // page itself handles the login gate, so we don't need to check trust
  // state here.
  if (cmd === 'publier' || cmd === 'publish') {
    await sendWhatsApp(from,
      pickLang(
        `📢 *Publier un événement*\n\nSoumettez votre événement ici:`,
        `📢 *Publish an event*\n\nSubmit your event here:`,
        lang,
      ) + `\n${BASE_URL}/events/submit`)
    return ok()
  }

  // "mes evenements" / "mes événements" / "my events" → list events the
  // customer has submitted with their current status. Pending events stay
  // visible so the publisher can track admin review.
  if (cmd === 'mes evenements' || cmd === 'mes événements' || cmd === 'my events') {
    const { data } = await supabaseAdmin
      .from('events')
      .select(`id, title, ${EVENT_DATE_COLUMNS}, is_active, auto_approved, event_status`)
      .or(organizerScope(customer.id))
      .order('date', { ascending: false })
      .limit(10)

    if (!data || data.length === 0) {
      await sendWhatsApp(from, pickLang(
        `📢 Vous n'avez pas encore soumis d'événement.\n\nEnvoyez "publier" pour en créer un.`,
        `📢 You haven't submitted an event yet.\n\nSend "publish" to create one.`,
        lang,
      ))
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
      ? pickLang(`✅ *Éditeur vérifié* — publication immédiate.`, `✅ *Verified publisher* — instant publishing.`, lang)
      : pickLang(
          `🛡 ${trust?.events_approved_count ?? 0}/3 approuvés pour la publication automatique.`,
          `🛡 ${trust?.events_approved_count ?? 0}/3 approved for auto-publish.`,
          lang,
        )

    const lines = data.map((e, i) => {
      const dateStr = formatEventDates(e, lang, 'compact')
      const statusLabel = e.event_status === 'cancelled'
        ? pickLang('❌ Annulé', '❌ Cancelled', lang)
        : !e.is_active
          ? pickLang('⏳ En attente d\'approbation', '⏳ Pending', lang)
          : e.auto_approved
            ? pickLang('⚡ Auto-publié', '⚡ Auto-published', lang)
            : pickLang('✅ Publié', '✅ Published', lang)
      return `${i + 1}. *${e.title}* (${dateStr})\n   ${statusLabel}`
    })
    await sendWhatsApp(from, `${pickLang('📢 *Vos événements:*', '📢 *Your events:*', lang)}\n\n${trustLine}\n\n${lines.join('\n\n')}`)
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
  const lang = normalizeLang(customer.preferred_language)

  if (cmd === 'annuler' || cmd === 'cancel') {
    await supabaseAdmin.from('signup_sessions').delete().eq('phone', phone)
    await sendWhatsApp(from, pickLang('❌ Annulé.', '❌ Cancelled.', lang))
    return ok()
  }

  // ── event_browse: customer typed a number from the list ──
  if (user_type === 'event_browse') {
    const n = parseInt(cmd, 10)
    const ids = (data?.event_ids as string[] | undefined) ?? []
    if (!Number.isFinite(n) || n < 1 || n > ids.length) {
      await sendWhatsApp(from, pickLang(
        `Envoyez un numéro entre 1 et ${ids.length}, ou "annuler".`,
        `Send a number between 1 and ${ids.length}, or "cancel".`,
        lang,
      ))
      return ok()
    }
    return showEventDetail(from, phone, ids[n - 1], lang)
  }

  // ── event_detail: "reserver" / "back" / arbitrary number for a new pick ──
  if (user_type === 'event_detail') {
    const eventId = data?.event_id as string | undefined
    if (cmd === 'reserver' || cmd === 'réserver' || cmd === 'reserve' || cmd === 'book') {
      if (!eventId) {
        await supabaseAdmin.from('signup_sessions').delete().eq('phone', phone)
        await sendWhatsApp(from, pickLang('Session expirée. Envoyez "evenements".', 'Session expired. Send "events".', lang))
        return ok()
      }
      return startReserveFlow(from, phone, eventId, lang, customer)
    }
    if (cmd === 'retour' || cmd === 'back') {
      // The previous event_browse ids may have been overwritten; tell the
      // user to re-list rather than re-fetching from a stale state.
      await supabaseAdmin.from('signup_sessions').delete().eq('phone', phone)
      await sendWhatsApp(from, pickLang('Envoyez "evenements" pour la liste.', 'Send "events" for the list.', lang))
      return ok()
    }
    await sendWhatsApp(from, pickLang(
      `Envoyez "reserver" pour réserver, "retour" pour la liste, ou "annuler".`,
      `Send "reserve" to book, "back" for the list, or "cancel".`,
      lang,
    ))
    return ok()
  }

  // ── event_reserve step 1: quantity ──
  if (user_type === 'event_reserve' && step === 1) {
    const q = parseInt(cmd, 10)
    if (!Number.isFinite(q) || q < 1 || q > 10) {
      await sendWhatsApp(from, pickLang(`Envoyez un nombre entre 1 et 10, ou "annuler".`, `Send 1-10, or "cancel".`, lang))
      return ok()
    }
    const eventId       = data?.event_id as string | undefined
    const eventTitle    = (data?.event_name as string) ?? ''
    const ticketPrice   = Number(data?.ticket_price ?? 0)
    if (!eventId) {
      await supabaseAdmin.from('signup_sessions').delete().eq('phone', phone)
      await sendWhatsApp(from, pickLang('Session expirée.', 'Session expired.', lang))
      return ok()
    }

    // Re-pull the event to verify capacity at submit time (the user may
    // have been sitting on the prompt while others booked).
    const { data: event } = await supabaseAdmin
      .from('events')
      .select(`id, title, ${EVENT_DATE_COLUMNS}, venue, organizer_id, submitted_by, whatsapp, is_active, event_status, ticket_price, max_tickets, tickets_sold, payment_enabled, payment_mode, whatsapp_payment_enabled, commission_rate, city`)
      .eq('id', eventId).maybeSingle()
    if (!event || !event.is_active || (event.event_status && ['cancelled', 'completed'].includes(event.event_status))) {
      await supabaseAdmin.from('signup_sessions').delete().eq('phone', phone)
      await sendWhatsApp(from, pickLang('❌ Événement clôturé.', '❌ Event closed.', lang))
      return ok()
    }
    const blockedStep1 = bookingBlock(event, customer, lang)
    if (blockedStep1) {
      await supabaseAdmin.from('signup_sessions').delete().eq('phone', phone)
      await sendWhatsApp(from, blockedStep1)
      return ok()
    }
    // Early answer only; the insert re-checks atomically (reserve_event_seats).
    const left = await seatsLeftToday(event)
    if (q > left) {
      await supabaseAdmin.from('signup_sessions').delete().eq('phone', phone)
      await sendWhatsApp(from, pickLang(
        `❌ Plus que ${left} places.`,
        `❌ Only ${left} spots left.`,
        lang,
      ))
      return ok()
    }

    const totalPrice = ticketPrice * q
    const commissionRate = Number(event.commission_rate ?? 0.10) || 0.10
    const commissionAmount = totalPrice > 0 ? Math.round(totalPrice * commissionRate) : 0

    // Effective WhatsApp mode: free events and vendors who haven't enabled
    // WhatsApp payment collapse to reservation_only.
    const isFree  = !(ticketPrice > 0)
    const effMode = effectiveWhatsAppMode(
      normalizeMode(event.payment_mode ?? modeFromLegacy(event.payment_enabled)),
      Boolean(event.whatsapp_payment_enabled),
      isFree,
    )

    if (effMode === 'reservation_only') {
      // Paid pay-at-door — offer a promo code before confirming. Free events
      // have nothing to discount, so they confirm immediately.
      if (totalPrice > 0) {
        const { error: sessErr } = await supabaseAdmin.from('signup_sessions').upsert({
          phone, user_type: 'event_reserve', step: 5,
          data: { ...data, quantity: q, base_total: totalPrice, commission_rate: commissionRate },
          expires_at: sessionExpiry(15),
        })
        if (sessErr) return sessionSaveFailed(from, 'event_reserve', sessErr, lang)
        await sendWhatsApp(from, pickLang(
          `🎫 Entrez un code promo, ou envoyez *oui* pour confirmer.`,
          `🎫 Enter a promo code, or send *yes* to confirm.`,
          lang,
        ))
        return ok()
      }
      return confirmEventReservationWhatsapp({ from, phone, customer, event, q, totalPrice, commissionAmount, ticketPrice, lang })
    }

    if (effMode === 'both') {
      // Let the customer choose pay-now vs reserve (step 3).
      const { error: sessErr } = await supabaseAdmin.from('signup_sessions').upsert({
        phone, user_type: 'event_reserve', step: 3,
        data: { ...data, quantity: q, total_price: totalPrice, commission_amount: commissionAmount },
        expires_at: sessionExpiry(15),
      })
      if (sessErr) return sessionSaveFailed(from, 'event_reserve', sessErr, lang)
      await sendWhatsApp(from, pickLang(
        `${q} × ${ticketPrice.toLocaleString()} = *${totalPrice.toLocaleString()} FCFA*\n\nComment souhaitez-vous payer?\n\n1. 💰 Payer maintenant (Mobile Money)\n2. 📋 Réserver (payer sur place)\n\nRépondez 1 ou 2`,
        `${q} × ${ticketPrice.toLocaleString()} = *${totalPrice.toLocaleString()} FCFA*\n\nHow would you like to pay?\n\n1. 💰 Pay now (Mobile Money)\n2. 📋 Reserve (pay at the door)\n\nReply 1 or 2`,
        lang,
      ))
      return ok()
    }

    // payment_only — advance to step 2 and ask for the MoMo number.
    return askEventMomoNumber(from, phone, data, q, ticketPrice, totalPrice, commissionAmount, lang)
    // eventTitle unused at this step — silence by referencing in the log on success.
    void eventTitle
  }

  // ── event_reserve step 5: promo code (pay-at-door path) ──
  // The customer types a code, or "oui/yes" to confirm without/with it.
  if (user_type === 'event_reserve' && step === 5) {
    const eventId   = data?.event_id as string | undefined
    const q         = Number(data?.quantity ?? 0)
    const baseTotal = Number(data?.base_total ?? 0)
    const commissionRate = Number(data?.commission_rate ?? 0.10) || 0.10
    if (!eventId || !q) {
      await supabaseAdmin.from('signup_sessions').delete().eq('phone', phone)
      await sendWhatsApp(from, pickLang('Session expirée.', 'Session expired.', lang))
      return ok()
    }
    const { data: event } = await supabaseAdmin
      .from('events')
      .select(`id, title, ${EVENT_DATE_COLUMNS}, venue, organizer_id, submitted_by, whatsapp, ticket_price`)
      .eq('id', eventId).maybeSingle()
    if (!event) {
      await supabaseAdmin.from('signup_sessions').delete().eq('phone', phone)
      await sendWhatsApp(from, pickLang('❌ Événement introuvable.', '❌ Event not found.', lang))
      return ok()
    }
    const blockedStep5 = bookingBlock(event, customer, lang)
    if (blockedStep5) {
      await supabaseAdmin.from('signup_sessions').delete().eq('phone', phone)
      await sendWhatsApp(from, blockedStep5)
      return ok()
    }
    const ticketPrice = Number(event.ticket_price ?? 0)

    // "oui/yes/ok" → confirm with whatever discount is currently on the session.
    if (['oui', 'yes', 'o', 'y', 'ok'].includes(cmd)) {
      const discount   = Number(data?.discount_amount ?? 0)
      const total      = Math.max(0, baseTotal - discount)
      const commission = total > 0 ? Math.round(total * commissionRate) : 0
      return confirmEventReservationWhatsapp({
        from, phone, customer, event: event as EventReserveRow, q,
        totalPrice: total, commissionAmount: commission, ticketPrice, lang,
        voucherCode: (data?.voucher_code as string) ?? null,
        voucherId:   (data?.voucher_id as string) ?? null,
        discountAmount: discount,
      })
    }

    // Otherwise treat the message as a promo code and validate it.
    const vres = await validateVoucher(cmd, { customerId: customer.id, eventId, orderTotal: baseTotal })
    if (!vres.ok) {
      await sendWhatsApp(from, pickLang(
        `Code invalide. Envoyez *oui* pour réserver sans code.`,
        `Invalid code. Send *yes* to reserve without a code.`,
        lang,
      ))
      return ok()
    }
    const discount = vres.discount
    const total    = Math.max(0, baseTotal - discount)
    const { error: sessErr } = await supabaseAdmin.from('signup_sessions').upsert({
      phone, user_type: 'event_reserve', step: 5,
      data: { ...data, voucher_code: vres.voucher.code, voucher_id: vres.voucher.id, discount_amount: discount },
      expires_at: sessionExpiry(15),
    })
    if (sessErr) return sessionSaveFailed(from, 'event_reserve', sessErr, lang)
    await sendWhatsApp(from, pickLang(
      `🎫 ${vres.voucher.code} appliqué! Nouveau total: *${total.toLocaleString()} FCFA*.\nEnvoyez *oui* pour confirmer.`,
      `🎫 ${vres.voucher.code} applied! New total: *${total.toLocaleString()} FCFA*.\nSend *yes* to confirm.`,
      lang,
    ))
    return ok()
  }

  // ── event_reserve step 2: MoMo number ──
  if (user_type === 'event_reserve' && step === 2) {
    const eventId       = data?.event_id as string | undefined
    const quantity      = Number(data?.quantity ?? 0)
    const totalPrice    = Number(data?.total_price ?? 0)
    const commissionAmount = Number(data?.commission_amount ?? 0)
    if (!eventId || !quantity || !totalPrice) {
      await supabaseAdmin.from('signup_sessions').delete().eq('phone', phone)
      await sendWhatsApp(from, pickLang('Session expirée.', 'Session expired.', lang))
      return ok()
    }
    const phoneNumber = cmd.replace(/[^\d+]/g, '')
    if (!phoneNumber) {
      await sendWhatsApp(from, pickLang('Envoyez un numéro MoMo (ex: 237670000000).', 'Send a MoMo number (e.g. 237670000000).', lang))
      return ok()
    }

    const { data: event } = await supabaseAdmin
      .from('events').select(`id, title, ${EVENT_DATE_COLUMNS}, city, organizer_id, submitted_by, whatsapp`).eq('id', eventId).maybeSingle()
    if (!event) {
      await supabaseAdmin.from('signup_sessions').delete().eq('phone', phone)
      await sendWhatsApp(from, pickLang('❌ Événement introuvable.', '❌ Event not found.', lang))
      return ok()
    }
    const blockedStep2 = bookingBlock(event, customer, lang)
    if (blockedStep2) {
      await supabaseAdmin.from('signup_sessions').delete().eq('phone', phone)
      await sendWhatsApp(from, blockedStep2)
      return ok()
    }

    const country = countryFromCity(event.city)
    const mno = detectMNO(phoneNumber, country ?? undefined)
    if (!mno) {
      await sendWhatsApp(from, pickLang(
        `❌ Numéro non supporté. Réessayez avec un numéro MTN ou Orange avec l'indicatif pays.`,
        `❌ Unsupported number. Try an MTN or Orange number with country code.`,
        lang,
      ))
      return ok()
    }

    // Book the pending reservation through reserve_event_seats (atomic,
    // per-day capacity, bumps the all-days counters). The deposit id is
    // stored with the row, before PawaPay is called, so a callback that beats
    // us — or a request that times out after PawaPay created the deposit —
    // still finds this reservation.
    const day = resolveBookingDay(event, null)
    if (!day) {
      await supabaseAdmin.from('signup_sessions').delete().eq('phone', phone)
      await sendWhatsApp(from, multiDayWebLink(event.id, event.title, lang))
      return ok()
    }
    const reservationCode = await generateReservationCode()
    const depositId = randomUUID()
    const booked = await reserveEventSeats(event.id, day, [{
      customer_id:        customer.id,
      customer_name:      customer.name,
      customer_phone:     customer.phone,
      quantity,
      total_price:        totalPrice,
      commission_amount:  commissionAmount,
      payment_status:     'pending',
      payment_id:         depositId,
      payment_method:     mno.correspondent,
      reservation_status: 'confirmed',
      reservation_code:   reservationCode,
      tier_id: null, tier_name: null, tier_price: null,
    }])
    if (!booked.ok) {
      await supabaseAdmin.from('signup_sessions').delete().eq('phone', phone)
      await sendWhatsApp(from, seatRefusalText(booked, lang))
      return ok()
    }
    const reservation = booked.rows[0]
    console.log('[whatsapp/reserve-pay] reservation=%s event=%s day=%s qty=%d', reservation.id, event.id, day, quantity)

    let depositResult
    try {
      depositResult = await createDeposit({
        amount:      totalPrice,
        currency:    mno.currency,
        phoneNumber,
        orderId:     reservation.id,
        description: `${event.title} ${reservation.id.slice(0, 6)}`,
        depositId,
      })
    } catch (e) {
      const f = depositFailure(e)
      console.error(`[whatsapp/reserve-pay] createDeposit failed reservation=${reservation.id} deposit=${depositId} definitive=${f.definitive}: ${(e as Error).message}`)
      if (f.definitive) {
        // No prompt will ever appear: settle as failed so the held seats go
        // back (settleDeposit's failed path releases them). 'status_poll'
        // sends no failure WhatsApp — the message below is the only one.
        const { settleDeposit } = await import('@/lib/payments-settle')
        await settleDeposit(depositId, { status: 'REJECTED', failureReason: f.reason }, 'status_poll')
        await sendWhatsApp(from, pickLang(
          `❌ Paiement refusé : ${f.reason}\n\nEnvoyez un autre numéro MoMo pour réessayer, ou "annuler".`,
          `❌ Payment refused: ${f.reason}\n\nSend another MoMo number to try again, or "cancel".`,
          lang,
        ))
      } else {
        // Outcome unknown: keep the reservation pending under its deposit id
        // — the webhook or the reconcile job settles it either way. End the
        // session so a retry can't double-book.
        await supabaseAdmin.from('signup_sessions').delete().eq('phone', phone)
        await sendWhatsApp(from, pickLang(
          `⏳ Le service de paiement ne répond pas. Si une demande de paiement apparaît sur votre téléphone, vous pouvez la valider — vous recevrez une confirmation.`,
          `⏳ The payment service is not responding. If a payment prompt appears on your phone you can approve it — you'll get a confirmation.`,
          lang,
        ))
      }
      return ok()
    }

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
    await sendWhatsApp(from, pickLang(
      `📱 *Validez sur votre téléphone*\n\nUn prompt PawaPay va apparaître. Confirmez avec votre code PIN.\n\nVous recevrez un message à la confirmation.`,
      `📱 *Confirm on your phone*\n\nA PawaPay prompt will appear. Confirm with your PIN.\n\nYou'll get a message on confirmation.`,
      lang,
    ))
    return ok()
  }

  // ── event_reserve step 3: 'both' mode — pay-now (1) vs reserve (2) ──
  if (user_type === 'event_reserve' && step === 3) {
    const choice = cmd.trim()
    if (choice !== '1' && choice !== '2') {
      await sendWhatsApp(from, pickLang(
        `Répondez *1* pour payer maintenant ou *2* pour réserver.`,
        `Reply *1* to pay now or *2* to reserve.`,
        lang,
      ))
      return ok()
    }
    const eventId          = data?.event_id as string | undefined
    const quantity         = Number(data?.quantity ?? 0)
    const totalPrice       = Number(data?.total_price ?? 0)
    const commissionAmount = Number(data?.commission_amount ?? 0)
    const ticketPrice      = Number(data?.ticket_price ?? 0)
    if (!eventId || !quantity) {
      await supabaseAdmin.from('signup_sessions').delete().eq('phone', phone)
      await sendWhatsApp(from, pickLang('Session expirée.', 'Session expired.', lang))
      return ok()
    }

    // Pay now → reuse the MoMo prompt (step 2 handles the rest).
    if (choice === '1') {
      return askEventMomoNumber(from, phone, data, quantity, ticketPrice, totalPrice, commissionAmount, lang)
    }

    // Reserve → re-pull the event to re-check capacity, then confirm.
    const { data: event } = await supabaseAdmin
      .from('events')
      .select(`id, title, ${EVENT_DATE_COLUMNS}, venue, organizer_id, submitted_by, whatsapp, is_active, event_status, max_tickets`)
      .eq('id', eventId).maybeSingle()
    if (!event || !event.is_active || (event.event_status && ['cancelled', 'completed'].includes(event.event_status))) {
      await supabaseAdmin.from('signup_sessions').delete().eq('phone', phone)
      await sendWhatsApp(from, pickLang('❌ Événement clôturé.', '❌ Event closed.', lang))
      return ok()
    }
    const blockedStep3 = bookingBlock(event, customer, lang)
    if (blockedStep3) {
      await supabaseAdmin.from('signup_sessions').delete().eq('phone', phone)
      await sendWhatsApp(from, blockedStep3)
      return ok()
    }
    return confirmEventReservationWhatsapp({ from, phone, customer, event, q: quantity, totalPrice, commissionAmount, ticketPrice, lang })
  }

  // Unknown event session shape — quietly clear it.
  await supabaseAdmin.from('signup_sessions').delete().eq('phone', phone)
  await sendWhatsApp(from, pickLang('Session expirée.', 'Session expired.', lang))
  return ok()
}

// ── Internal helpers for the event flow ──────────────────────────────────────

// Seats still free today on a single-day event (event-wide cap; the chat flow
// books without a tier). Infinity when uncapped or unknown — the insert
// re-checks atomically either way.
async function seatsLeftToday(event: { id: string; date: string | null; end_date: string | null }): Promise<number> {
  const day = resolveBookingDay(event, null)
  if (!day) return Infinity
  const days = await getEventAvailability(event.id, todayISO())
  const remaining = days?.find(d => d.date === day)?.remaining
  return remaining === null || remaining === undefined ? Infinity : remaining
}

// Multi-day events are booked on the website, where the customer picks a day.
function multiDayWebLink(eventId: string, title: string, lang: Lang): string {
  return pickLang(
    `🗓️ *${title}* dure plusieurs jours : choisissez votre jour et réservez sur le site :\n${BASE_URL}/events/${eventId}`,
    `🗓️ *${title}* runs over several days: pick your day and book on the website:\n${BASE_URL}/events/${eventId}`,
    lang,
  )
}

// A booking refused by reserve_event_seats, in the customer's language.
function seatRefusalText(result: Extract<ReserveSeatsResult, { ok: false }>, lang: Lang): string {
  const left = result.body.remaining
  if (left === 0) return pickLang('❌ Complet.', '❌ Sold out.', lang)
  if (typeof left === 'number') return pickLang(`❌ Plus que ${left} places.`, `❌ Only ${left} spots left.`, lang)
  return pickLang('⚠️ Réservation impossible pour le moment. Réessayez.', '⚠️ Booking not possible right now. Please try again.', lang)
}

// Minimal event shape the reservation confirmation needs.
interface EventReserveRow {
  id: string; title: string; date: string; time: string | null
  end_date: string | null; end_time: string | null
  venue: string | null; organizer_id: string | null; submitted_by?: string | null
  whatsapp: string | null
}

// A signup_sessions save that fails must never be followed by its prompt: the
// customer's answer would go nowhere. That is exactly how the event and
// reservation flows died silently — the user_type CHECK rejected them and no
// one read the error — so log it loudly and ask the customer to retry instead.
async function sessionSaveFailed(
  from: string, userType: string, err: { code?: string; message: string }, lang: Lang,
): Promise<NextResponse> {
  console.error('[whatsapp] %s session upsert failed:', userType, err.code, err.message)
  await sendWhatsApp(from, pickLang('❌ Erreur. Réessayez.', '❌ Error. Retry.', lang))
  return ok()
}

// Sets the session to step 2 and prompts for the Mobile Money number. Shared by
// the payment_only path and the 'both' → pay-now choice.
async function askEventMomoNumber(
  from: string, phone: string, data: Record<string, unknown>,
  q: number, ticketPrice: number, totalPrice: number, commissionAmount: number, lang: Lang,
): Promise<NextResponse> {
  const { error: sessErr } = await supabaseAdmin.from('signup_sessions').upsert({
    phone, user_type: 'event_reserve', step: 2,
    data: { ...data, quantity: q, total_price: totalPrice, commission_amount: commissionAmount },
    expires_at: sessionExpiry(15),
  })
  if (sessErr) return sessionSaveFailed(from, 'event_reserve', sessErr, lang)
  await sendWhatsApp(from,
    `💰 ${q} × ${ticketPrice.toLocaleString()} = *${totalPrice.toLocaleString()} FCFA*\n\n` +
    pickLang(
      `Envoyez votre numéro Mobile Money pour payer.\n\nEx: 237670000000\n\nOu "annuler"`,
      `Send your Mobile Money number to pay.\n\nEx: 237670000000\n\nOr "cancel"`,
      lang,
    ))
  return ok()
}

// Books a free / pay-at-door event reservation through reserve_event_seats
// (atomic per-day capacity), confirms to the customer and pings the
// organizer. Shared by reservation_only and the 'both' → reserve choice.
async function confirmEventReservationWhatsapp(opts: {
  from: string; phone: string; customer: OrderingCustomer
  event: EventReserveRow; q: number; totalPrice: number; commissionAmount: number
  ticketPrice: number; lang: Lang
  voucherCode?: string | null; voucherId?: string | null; discountAmount?: number
}): Promise<NextResponse> {
  const { from, phone, customer, event, q, totalPrice, commissionAmount, ticketPrice, lang } = opts
  // Last line of defence — every path funnels through here before the insert.
  const blocked = bookingBlock(event, customer, lang)
  if (blocked) {
    await supabaseAdmin.from('signup_sessions').delete().eq('phone', phone)
    await sendWhatsApp(from, blocked)
    return ok()
  }
  const voucherCode = opts.voucherCode ?? null
  const discountAmount = opts.discountAmount ?? 0
  const day = resolveBookingDay(event, null)
  if (!day) {
    await supabaseAdmin.from('signup_sessions').delete().eq('phone', phone)
    await sendWhatsApp(from, multiDayWebLink(event.id, event.title, lang))
    return ok()
  }
  const reservationCode = await generateReservationCode()
  const booked = await reserveEventSeats(event.id, day, [{
    customer_id:        customer.id,
    customer_name:      customer.name,
    customer_phone:     customer.phone,
    quantity:           q,
    total_price:        totalPrice,
    commission_amount:  commissionAmount,
    discount_amount:    discountAmount,
    voucher_code:       voucherCode,
    payment_status:     'not_required',
    reservation_status: 'confirmed',
    reservation_code:   reservationCode,
    tier_id: null, tier_name: null, tier_price: null,
  }])
  if (!booked.ok) {
    await supabaseAdmin.from('signup_sessions').delete().eq('phone', phone)
    await sendWhatsApp(from, seatRefusalText(booked, lang))
    return ok()
  }
  const reservation = booked.rows[0]
  if (opts.voucherId) await consumeVoucherForReservation(opts.voucherId, customer.id)
  console.log('[whatsapp/reserve] reservation=%s event=%s day=%s qty=%d', reservation.id, event.id, day, q)
  await writeAudit({
    action:          'event_reservation_created',
    targetType:      'event_reservation',
    targetId:        reservation.id,
    performedBy:     customer.id,
    performedByType: 'customer',
    metadata:        { event_id: event.id, event_title: event.title, quantity: q, total_price: totalPrice, paid: false, via: 'whatsapp' },
  })
  await supabaseAdmin.from('signup_sessions').delete().eq('phone', phone)

  // Customer message date in the customer's language; pingOrganizer formats
  // its own date in the organizer's language.
  const whenStr = formatEventWhen(event, lang, 'message')
  const payLine = ticketPrice > 0
    ? '\n' + pickLang(
        `💰 Paiement sur place: ${totalPrice.toLocaleString()} FCFA`,
        `💰 Pay at the door: ${totalPrice.toLocaleString()} FCFA`,
        lang,
      )
    : ''
  await sendWhatsApp(from, [
    pickLang(`✅ *Réservation confirmée!*`, `✅ *Reservation confirmed!*`, lang),
    ``,
    `🎉 ${event.title}`,
    `📅 ${whenStr}`,
    event.venue ? `📍 ${event.venue}` : '',
    pickLang(`🎟 ${q} place(s)`, `🎟 ${q} spot(s)`, lang),
    pickLang(`🎫 Code de réservation: *#${reservationCode}*`, `🎫 Reservation code: *#${reservationCode}*`, lang),
    voucherCode && discountAmount > 0
      ? pickLang(`🎫 Code ${voucherCode}: -${discountAmount.toLocaleString()} FCFA`, `🎫 Code ${voucherCode}: -${discountAmount.toLocaleString()} FCFA`, lang)
      : '',
    payLine,
  ].filter(Boolean).join('\n'))

  await pingOrganizer(event, customer, q, totalPrice, reservationCode)
  return ok()
}

// Pulls a single event and shows the detail card. Pushes the event_detail
// session so "reserver" without a code resolves to this event.
async function showEventDetail(from: string, phone: string, eventId: string, lang: Lang = 'fr'): Promise<NextResponse> {
  const { data: event } = await supabaseAdmin
    .from('events')
    .select(`id, title, ${EVENT_DATE_COLUMNS}, venue, neighborhood, city, whatsapp, ticket_price, max_tickets, tickets_sold, payment_enabled, event_status, is_active`)
    .eq('id', eventId).maybeSingle()
  if (!event || !event.is_active) {
    await supabaseAdmin.from('signup_sessions').delete().eq('phone', phone)
    await sendWhatsApp(from, pickLang(`❌ Événement indisponible.`, `❌ Event unavailable.`, lang))
    return ok()
  }
  const whenStr = formatEventWhen(event, lang, 'chatDetail')
  const venueLine = event.venue
    ? `📍 ${event.venue}${event.neighborhood ? ', ' + event.neighborhood : ''}${event.city ? ' — ' + event.city : ''}`
    : ''
  const priceLine = !event.ticket_price || event.ticket_price <= 0
    ? pickLang(`🎫 Gratuit`, `🎫 Free`, lang)
    : pickLang(`🎫 ${Number(event.ticket_price).toLocaleString()} FCFA / personne`, `🎫 ${Number(event.ticket_price).toLocaleString()} FCFA / person`, lang)
  // Seats left come from the reservations that hold seats (per day). A
  // multi-day event is booked on the website, so no single number here.
  const left = event.max_tickets && event.max_tickets > 0 && !isMultiDay(event)
    ? await seatsLeftToday(event)
    : Infinity
  const remaining = left === Infinity ? null : left
  const capacityLine = remaining != null
    ? `👥 ${remaining} ${remaining > 0 ? pickLang('places restantes', 'spots remaining', lang) : pickLang('— ❌ Complet', '— ❌ Sold out', lang)}`
    : ''
  const past = isPastEvent(event)
  const tail = past
    ? '\n' + `⏳ ${pickLang(`${PAST_EVENT_MESSAGE_FR}.`, `${PAST_EVENT_MESSAGE_EN}.`, lang)}`
    : remaining === 0
      ? '\n' + pickLang(`❌ Cet événement est complet.`, `❌ This event is sold out.`, lang)
      : isMultiDay(event)
        ? '\n' + multiDayWebLink(event.id, event.title, lang)
        : '\n' + pickLang(
            `💡 Envoyez 'reserver' pour réserver, ou 'retour' pour la liste.`,
            `💡 Send 'reserve' to book, or 'back' for the list.`, lang)

  const { error: sessErr } = await supabaseAdmin.from('signup_sessions').upsert({
    phone, user_type: 'event_detail', step: 1,
    data: { event_id: event.id, event_name: event.title },
    expires_at: sessionExpiry(15),
  })
  if (sessErr) return sessionSaveFailed(from, 'event_detail', sessErr, lang)

  await sendWhatsApp(from, [
    `🎉 *${event.title}*`,
    `📅 ${whenStr}`,
    venueLine,
    priceLine,
    capacityLine,
    event.whatsapp ? `📱 Contact: ${event.whatsapp}` : '',
    tail,
  ].filter(Boolean).join('\n'))
  return ok()
}

// Shared "can this person book this event right now?" guard for the chat
// flow. Returns the reply to send, or null when the booking may proceed.
// Mirrors the server-side rules in /api/events/[id]/reserve so the two
// entry points can't drift apart.
function bookingBlock(
  event: {
    id: string; title?: string; date: string | null; end_date: string | null
    organizer_id?: string | null; submitted_by?: string | null; whatsapp?: string | null
  },
  customer: OrderingCustomer | undefined,
  lang: Lang,
): string | null {
  if (isPastEvent(event)) {
    console.log('[whatsapp/reserve] blocked — event %s is past (date=%s end_date=%s)', event.id, event.date, event.end_date)
    return `⏳ ${pickLang(`${PAST_EVENT_MESSAGE_FR}.`, `${PAST_EVENT_MESSAGE_EN}.`, lang)}`
  }
  if (!customer) return null
  const selfById    = isEventOrganizer(event, customer.id)
  const selfByPhone = samePhone(event.whatsapp, customer.phone)
  if (selfById || selfByPhone) {
    console.log('[whatsapp/reserve] blocked self-booking on event=%s (byId=%s byPhone=%s)', event.id, selfById, selfByPhone)
    return pickLang(
      '🚫 Vous ne pouvez pas réserver votre propre événement.',
      '🚫 You cannot book your own event.',
      lang,
    )
  }
  return null
}

// Verifies the event is bookable in-chat and either inserts the
// reservation directly or kicks off the multi-step quantity prompt.
async function startReserveFlow(
  from: string, phone: string, eventId: string, lang: Lang = 'fr',
  // Present for every in-chat path; used to block an organizer from booking
  // their own event before the quantity prompt even opens.
  customer?: OrderingCustomer,
): Promise<NextResponse> {
  const { data: event } = await supabaseAdmin
    .from('events')
    .select(`id, title, ${EVENT_DATE_COLUMNS}, organizer_id, submitted_by, whatsapp, ticket_price, max_tickets, tickets_sold, payment_enabled, is_active, event_status`)
    .eq('id', eventId).maybeSingle()
  if (!event || !event.is_active) {
    await supabaseAdmin.from('signup_sessions').delete().eq('phone', phone)
    await sendWhatsApp(from, pickLang('❌ Événement indisponible.', '❌ Event unavailable.', lang))
    return ok()
  }
  if (event.event_status && ['cancelled', 'completed'].includes(event.event_status)) {
    await sendWhatsApp(from, pickLang('❌ Événement clôturé.', '❌ Event closed.', lang))
    return ok()
  }
  const blocked = bookingBlock(event, customer, lang)
  if (blocked) {
    await supabaseAdmin.from('signup_sessions').delete().eq('phone', phone)
    await sendWhatsApp(from, blocked)
    return ok()
  }
  // Multi-day events are booked per day on the website (day picker); the
  // chat flow has no day step.
  if (isMultiDay(event)) {
    await supabaseAdmin.from('signup_sessions').delete().eq('phone', phone)
    await sendWhatsApp(from, multiDayWebLink(event.id, event.title, lang))
    return ok()
  }
  const remaining = await seatsLeftToday(event)
  if (remaining === 0) {
    await sendWhatsApp(from, pickLang('❌ Complet.', '❌ Sold out.', lang))
    return ok()
  }

  const { error: sessErr } = await supabaseAdmin.from('signup_sessions').upsert({
    phone, user_type: 'event_reserve', step: 1,
    data: {
      event_id:        event.id,
      event_name:      event.title,
      ticket_price:    Number(event.ticket_price ?? 0),
      payment_enabled: !!event.payment_enabled,
    },
    expires_at: sessionExpiry(15),
  })
  if (sessErr) return sessionSaveFailed(from, 'event_reserve', sessErr, lang)
  const cap = remaining === Infinity ? 10 : Math.min(10, remaining)
  await sendWhatsApp(from, pickLang(
    `Combien de places? (1-${cap})\n\nOu "annuler"`,
    `How many spots? (1-${cap})\n\nOr "cancel"`,
    lang,
  ))
  return ok()
}

// Organizer ping for free / pay-at-door reservations. Paid reservations
// notify on the webhook → notifyPaidReservation path.
async function pingOrganizer(
  event:    { id: string; title: string; date: string; end_date: string | null; organizer_id: string | null; whatsapp: string | null },
  customer: OrderingCustomer,
  quantity: number,
  total:    number,
  reservationCode?: string,
): Promise<void> {
  let organizerPhone: string | null = null
  if (event.organizer_id) {
    const { data: o } = await supabaseAdmin.from('customers').select('phone').eq('id', event.organizer_id).maybeSingle()
    organizerPhone = o?.phone ?? null
  }
  if (!organizerPhone && event.whatsapp) organizerPhone = event.whatsapp
  if (!organizerPhone) return
  const orgLang = await getLangByPhone(organizerPhone)
  // Format the date in the ORGANIZER's language — don't inherit the customer's.
  const dateStr = formatEventDates(event, orgLang, 'message')
  await sendWhatsApp(organizerPhone, [
    reservationCode
      ? pickLang(`🔔 *Nouvelle réservation!* — #${reservationCode}`, `🔔 *New reservation!* — #${reservationCode}`, orgLang)
      : pickLang(`🔔 *Nouvelle réservation!*`, `🔔 *New reservation!*`, orgLang),
    ``,
    `🎉 ${event.title}`,
    `📅 ${dateStr}`,
    `👤 ${customer.name}`,
    `📱 ${customer.phone}`,
    `🎟 ${quantity} ${pickLang('place(s)', 'spot(s)', orgLang)}`,
    total > 0 ? `💰 ${total.toLocaleString()} FCFA` : '',
  ].filter(Boolean).join('\n'), { context: 'event_reservation', relatedId: event.id }).catch(() => null)
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
  const lang = normalizeLang(customer.preferred_language)

  // Universal exit — "no"/"non"/"cancel"/"annuler"/"exit"/"quitter"/"stop"
  // bail out of the order at ANY step (the old flow only honoured no/non at
  // the confirm step, which is how sessions got wedged). Routing catches most
  // of these upstream; this is the order-specific, localized reply.
  if (cmd === 'non' || cmd === 'no' || cmd === 'annuler' || cmd === 'cancel'
      || cmd === 'exit' || cmd === 'quitter' || cmd === 'stop') {
    await supabaseAdmin.from('signup_sessions').delete().eq('phone', phone)
    await sendWhatsApp(from, pickLang('❌ Commande annulée.', '❌ Order cancelled.', lang))
    return ok()
  }

  // Step 1: waiting for restaurant number
  if (step === 1) {
    const num = parseInt(cmd, 10)
    const candidates = (data as unknown as { candidates?: Array<{ id: string; name: string }> }).candidates ?? []
    if (!Number.isFinite(num) || num < 1 || num > candidates.length) {
      await sendWhatsApp(from, pickLang(
        `Envoyez un numéro entre 1 et ${candidates.length}.`,
        `Send a number between 1 and ${candidates.length}.`,
        lang,
      ))
      return ok()
    }
    const chosen = candidates[num - 1]
    const menu = await loadAvailableMenu(chosen.id)
    if (menu.length === 0) {
      await sendWhatsApp(from, `🍽️ *${chosen.name}*\n\n${pickLang(`Ce restaurant n'a pas encore de plat disponible.\nEssayez un autre restaurant. Renvoyez "commander".`, `No available dishes yet.\nTry another restaurant. Send "commander" again.`, lang)}`)
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
          lang,
        )
        if (restRow.allow_orders_when_closed === false) {
          // Hard block — abandon the session and tell the customer the
          // schedule so they know when to come back.
          await sendWhatsApp(from,
            pickLang(
              `⚠️ *${chosen.name} est fermé*\n\nHoraires:\n${weekLines.join('\n')}\n\nRéessayez à l'ouverture.`,
              `⚠️ *${chosen.name} is closed*\n\nHours:\n${weekLines.join('\n')}\n\nTry again when they open.`,
              lang,
            ))
          await supabaseAdmin.from('signup_sessions').delete().eq('phone', phone)
          return ok()
        }
        // Soft warning — keep the session alive but signal the wait.
        const nextLine = status.next_transition?.kind === 'opens'
          ? pickLang(`Ouvre à ${status.next_transition.at}.`, `Opens at ${status.next_transition.at}.`, lang)
          : ''
        await sendWhatsApp(from, pickLang(
          `⚠️ *${chosen.name}* est fermé actuellement. ${nextLine}\nVotre commande sera traitée à l'ouverture.`,
          `⚠️ *${chosen.name}* is currently closed. ${nextLine}\nYour order will be processed when they open.`,
          lang,
        ))
      }
    }
    await supabaseAdmin.from('signup_sessions').update({
      step: 2,
      data: { restaurant_id: chosen.id, restaurant_name: chosen.name, menu },
      expires_at: sessionExpiry(15),
    }).eq('phone', phone)
    await sendWhatsApp(from, buildMenuMessage(chosen.name, menu, lang))
    return ok()
  }

  // Step 2: waiting for order syntax
  if (step === 2) {
    const menu = data.menu ?? []
    const result = parseOrder(body, menu, lang)
    if (!result.ok) {
      await sendWhatsApp(from, `${result.error}\n\n${pickLang('Renvoyez la commande ou "annuler".', 'Send the order again or "cancel".', lang)}`)
      return ok()
    }
    await supabaseAdmin.from('signup_sessions').update({
      step: 3,
      data: { ...data, items: result.items, total: result.total },
      expires_at: sessionExpiry(15),
    }).eq('phone', phone)
    await sendWhatsApp(from, buildSummaryMessage(data.restaurant_name, result.items, result.total, lang))
    return ok()
  }

  // Step 3: waiting for oui/non (or a voucher code)
  if (step === 3) {
    if (cmd === 'oui' || cmd === 'yes' || cmd === 'ok') {
      const items = data.items ?? []
      const subtotal = data.total ?? 0
      if (items.length === 0 || subtotal <= 0) {
        await supabaseAdmin.from('signup_sessions').delete().eq('phone', phone)
        await sendWhatsApp(from, pickLang('❌ Commande invalide. Recommencez avec "commander".', '❌ Invalid order. Start again with "commander".', lang))
        return ok()
      }

      const discount = data.voucher_discount ?? 0
      const total = Math.max(0, subtotal - discount)

      // Resolve the restaurant's payment mode + the separate WhatsApp payment
      // flag. effectiveWhatsAppMode collapses to reservation_only whenever the
      // vendor hasn't enabled WhatsApp payment — independent of the web mode.
      const { data: rest } = await supabaseAdmin
        .from('restaurants')
        .select('payment_mode, payment_enabled, whatsapp_payment_enabled, city')
        .eq('id', data.restaurant_id)
        .maybeSingle()
      const effMode = effectiveWhatsAppMode(
        normalizeMode(rest?.payment_mode ?? modeFromLegacy(rest?.payment_enabled)),
        Boolean(rest?.whatsapp_payment_enabled),
      )
      const restaurantCity = rest?.city ?? ''

      // 'both' — pause and let the customer choose pay-now vs reserve (step 4).
      if (effMode === 'both') {
        await supabaseAdmin.from('signup_sessions').update({
          step: 4,
          data: { ...data, restaurant_city: restaurantCity },
          expires_at: sessionExpiry(15),
        }).eq('phone', phone)
        await sendWhatsApp(from, pickLang(
          `Comment souhaitez-vous payer?\n\n1. 💰 Payer maintenant (Mobile Money)\n2. 📋 Réserver (payer sur place)\n\nRépondez 1 ou 2`,
          `How would you like to pay?\n\n1. 💰 Pay now (Mobile Money)\n2. 📋 Reserve (pay at restaurant)\n\nReply 1 or 2`,
          lang,
        ))
        return ok()
      }

      return finalizeRestaurantWhatsappOrder({
        from, phone, customer, data, items, total, discount,
        restaurantCity, paid: effMode === 'payment_only', lang,
      })
    }

    // ("no"/"non"/"cancel" are handled by the universal exit guard above.)

    // A digit-led token here ("1", "2x3", "5x1") means the customer is trying
    // to pick menu items, not enter a voucher. Running it through the voucher
    // lookup would return a baffling "Code not found"; point them at the menu
    // syntax instead and keep the confirmed order intact.
    if (/^\d/.test(body.trim())) {
      await sendWhatsApp(from, `${itemNotFoundMessage(lang)}\n\n${pickLang('Votre commande est prête — envoyez "oui" pour confirmer ou "non" pour annuler.', 'Your order is ready — send "yes" to confirm or "no" to cancel.', lang)}`)
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
        await sendWhatsApp(from, `❌ ${result.message}\n\n${pickLang('Envoyez "oui" pour confirmer ou "non" pour annuler.', 'Send "yes" to confirm or "no" to cancel.', lang)}`)
        return ok()
      }
      await supabaseAdmin.from('signup_sessions').update({
        data: {
          ...data,
          voucher_id:       result.voucher.id,
          voucher_code:     result.voucher.code,
          voucher_discount: result.discount,
        },
        expires_at: sessionExpiry(15),
      }).eq('phone', phone)

      const lines = (data.items ?? []).map(i => `${i.quantity}× ${i.name} — ${(i.quantity * i.price).toLocaleString()} FCFA`)
      await sendWhatsApp(from, [
        pickLang(`🏷️ Code *${result.voucher.code}* appliqué!`, `🏷️ Code *${result.voucher.code}* applied!`, lang),
        ``,
        `🏪 ${data.restaurant_name}`,
        ...lines,
        ``,
        pickLang(`Sous-total: ${subtotal.toLocaleString()} FCFA`, `Subtotal: ${subtotal.toLocaleString()} FCFA`, lang),
        pickLang(`Remise: −${result.discount.toLocaleString()} FCFA`, `Discount: −${result.discount.toLocaleString()} FCFA`, lang),
        pickLang(`💰 *Nouveau total: ${result.finalTotal.toLocaleString()} FCFA*`, `💰 *New total: ${result.finalTotal.toLocaleString()} FCFA*`, lang),
        ``,
        pickLang(`Envoyez "oui" pour confirmer ou "non" pour annuler.`, `Send "yes" to confirm or "no" to cancel.`, lang),
      ].join('\n'))
      return ok()
    }

    await sendWhatsApp(from, pickLang('Envoyez "oui" pour confirmer, "non" pour annuler, ou un code promo.', 'Send "yes", "no", or a voucher code.', lang))
    return ok()
  }

  // Step 4: 'both' mode — waiting for the pay-now (1) vs reserve (2) choice.
  if (step === 4) {
    const choice = body.trim()
    if (choice !== '1' && choice !== '2') {
      await sendWhatsApp(from, pickLang(
        `Répondez *1* pour payer maintenant ou *2* pour réserver.`,
        `Reply *1* to pay now or *2* to reserve.`,
        lang,
      ))
      return ok()
    }
    const items = data.items ?? []
    const subtotal = data.total ?? 0
    if (items.length === 0 || subtotal <= 0) {
      await supabaseAdmin.from('signup_sessions').delete().eq('phone', phone)
      await sendWhatsApp(from, pickLang('❌ Commande invalide. Recommencez avec "commander".', '❌ Invalid order. Start again with "commander".', lang))
      return ok()
    }
    const discount = data.voucher_discount ?? 0
    const total = Math.max(0, subtotal - discount)
    return finalizeRestaurantWhatsappOrder({
      from, phone, customer, data, items, total, discount,
      restaurantCity: data.restaurant_city ?? '', paid: choice === '1', lang,
    })
  }

  // Unexpected step
  await supabaseAdmin.from('signup_sessions').delete().eq('phone', phone)
  await sendWhatsApp(from, pickLang('Session expirée. Envoyez "aide".', 'Session expired. Send "help".', lang))
  return ok()
}

// Inserts the order row + items, consumes any voucher, writes audit, and then
// runs the paid path (initiate PawaPay, defer vendor ping to the webhook) or
// the reservation path (confirm + notify vendors immediately). Shared by the
// payment_only / reservation_only branches and the 'both' choice (step 4).
async function finalizeRestaurantWhatsappOrder(opts: {
  from: string
  phone: string
  customer: OrderingCustomer
  data: OrderingSessionData
  items: CartItem[]
  total: number
  discount: number
  restaurantCity: string
  paid: boolean
  lang: Lang
}): Promise<NextResponse> {
  const { from, phone, customer, data, items, total, discount, restaurantCity, paid, lang } = opts

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
      order_type:      paid ? 'paid_order' : 'reservation',
      payment_status:  paid ? 'pending'    : 'not_required',
    })
    .select('id')
    .single()

  if (orderErr || !newOrder) {
    console.error('[ordering] order insert failed:', orderErr?.message)
    await sendWhatsApp(from, pickLang('❌ Erreur lors de la création de la commande. Réessayez.', '❌ Error creating order. Please retry.', lang))
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
      order_type:    paid ? 'paid_order' : 'reservation',
    },
  })

  // ── Paid path: ask for the wallet PIN, defer vendor ping to the
  // payment webhook (a pending payment shouldn't wake up the kitchen).
  if (paid) {
    // On failure the order stays payment_status='pending' so the customer
    // can retry with "payer"; initiateWhatsappPayment has already told them
    // why, so no second message here.
    await initiateWhatsappPayment(
      from,
      newOrder.id,
      customer.id,
      customer.phone,
      total,
      data.restaurant_name,
      restaurantCity,
      lang,
    )
    return ok()
  }

  // ── Reservation path (default): notify vendors immediately. ───────────
  const id4 = last4(newOrder.id)
  const custLang = normalizeLang(customer.preferred_language)
  const confirmLines = [
    pickLang(`✅ *Commande confirmée!*`, `✅ *Order confirmed!*`, custLang),
    pickLang(`🧾 Commande #${id4}`, `🧾 Order #${id4}`, custLang),
    `🏪 ${data.restaurant_name}`,
  ]
  if (discount > 0 && data.voucher_code) {
    confirmLines.push(`🏷️ ${data.voucher_code} (−${discount.toLocaleString()} FCFA)`)
  }
  confirmLines.push(`💰 Total: ${total.toLocaleString()} FCFA`)
  const custPrepLine = await prepTimeLine(data.restaurant_id, '🕐', custLang)
  if (custPrepLine) confirmLines.push(custPrepLine)
  confirmLines.push(``, pickLang(
    `Le restaurant a été notifié. Vous recevrez un message quand votre commande sera prête!`,
    `The restaurant has been notified. You'll receive a message when your order is ready!`,
    custLang,
  ))
  confirmLines.push(``, pickLang(
    `💡 Envoyez 'mes commandes' pour suivre votre commande.`,
    `💡 Send 'my orders' to track your order.`, custLang))
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

  const deliverMatch  = body.match(/^(?:livre|livré|delivered|recupere|récupéré|picked(?:\s*up)?)\s+([0-9a-f]{4})$/i)
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
  const vendorLang = await getLangByPhone(from)

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
    await sendWhatsApp(from, pickLang(
      `❌ Commande #${upper} introuvable pour ${restaurant.name}.`,
      `❌ Order #${upper} not found for ${restaurant.name}.`, vendorLang))
    return ok()
  }
  if (matching.length > 1) {
    await sendWhatsApp(from, pickLang(
      `⚠️ Plusieurs commandes correspondent à #${upper}. Contactez le support.`,
      `⚠️ Multiple orders match #${upper}. Contact support.`, vendorLang))
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
      await sendWhatsApp(from, pickLang(
        `❌ Commande #${upper} déjà payée dans l'app.`,
        `❌ Order #${upper} already paid in-app.`, vendorLang))
      return ok()
    }
    if (order.payment_status === 'paid') {
      await sendWhatsApp(from, pickLang(
        `Commande #${upper} déjà payée.`,
        `Order #${upper} already paid.`, vendorLang))
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
      await sendWhatsApp(from, pickLang(
        `⚠️ Impossible de marquer payé: ${updErr.message}${hint}.`,
        `⚠️ Couldn't mark paid: ${updErr.message}${hint}.`, vendorLang))
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
    await sendWhatsApp(from, pickLang(
      `💰 Paiement confirmé pour #${upper} (${label.fr}). Vous pouvez maintenant confirmer la commande.`,
      `💰 Payment confirmed for #${upper} (${label.en}). You can now confirm the order.`, vendorLang))

    // Mirror the API route — let the customer know their tab is settled.
    if (order.customer_phone) {
      const payLang = await getLangByPhone(order.customer_phone)
      await sendWhatsApp(order.customer_phone, pickLang([
        `💰 *Paiement confirmé par ${restaurant.name}*`,
        ``,
        `🧾 Commande #${upper}`,
        `💳 ${label.fr}`,
        `💰 ${Number(order.total_price).toLocaleString()} FCFA`,
        ``,
        `Merci!`,
      ].join('\n'), [
        `💰 *Payment confirmed by ${restaurant.name}*`,
        ``,
        `🧾 Order #${upper}`,
        `💳 ${label.en}`,
        `💰 ${Number(order.total_price).toLocaleString()} FCFA`,
        ``,
        `Thank you!`,
      ].join('\n'), payLang))
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
      await sendWhatsApp(from, pickLang(
        `⚠️ Impossible d'annuler: migration manquante. Contactez le support.`,
        `⚠️ Cannot cancel: migration not applied. Contact support.`, vendorLang))
      return ok()
    }
    await writeAudit({ action: 'order_cancelled', targetType: 'order', targetId: order.id, performedBy: restaurant.id, performedByType: 'vendor' })
    await sendWhatsApp(from, pickLang(
      `❌ Commande #${upper} annulée. Le client est notifié.`,
      `❌ Order #${upper} cancelled. Customer notified.`, vendorLang))
    const cancLang = await getLangByPhone(order.customer_phone)
    await notifyCustomerOrderCancelled(order.customer_phone, payload, restaurant.name, cancLang)
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
    await sendWhatsApp(from, pickLang(
      `⏳ Le paiement n'est pas encore confirmé pour la commande #${upper}.`,
      `⏳ Payment has not been confirmed yet for order #${upper}.`, vendorLang))
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
    await sendWhatsApp(from, pickLang(
      `Commande #${upper} en statut ${order.status}, transition vers ${target} impossible.`,
      `Order #${upper} is ${order.status}, can't transition to ${target}.`, vendorLang))
    return ok()
  }

  const { error: updErr } = await supabaseAdmin
    .from('orders')
    .update({ status: target, updated_at: new Date().toISOString() })
    .eq('id', order.id)
  if (updErr) {
    console.error(`[ordering] status update to ${target} failed:`, updErr.message)
    await sendWhatsApp(from, pickLang(
      `⚠️ Impossible de mettre à jour: ${updErr.message}.`,
      `⚠️ Couldn't update: ${updErr.message}.`, vendorLang))
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

  // Vendor ack (in the vendor's language) + a hint for the next status step,
  // plus the customer ping in the customer's stored language.
  const custLang = await getLangByPhone(order.customer_phone)
  if (target === 'confirmed') {
    await sendWhatsApp(from,
      pickLang(`✅ Commande #${upper} confirmée. Le client est notifié.`, `✅ Order #${upper} confirmed. Customer notified.`, vendorLang) + `\n\n` +
      pickLang(`💡 Envoyez 'preparer ${upper}' quand vous commencez la préparation.`, `💡 Send 'preparing ${upper}' when you start preparing.`, vendorLang))
    await notifyCustomerOrderConfirmed(order.customer_phone, payload, restaurant.name, custLang)
  } else if (target === 'preparing') {
    await sendWhatsApp(from,
      pickLang(`🍳 Commande #${upper} — préparation démarrée.`, `🍳 Order #${upper} — preparation started.`, vendorLang) + `\n\n` +
      pickLang(`💡 Envoyez 'pret ${upper}' quand la commande est prête.`, `💡 Send 'ready ${upper}' when the order is ready.`, vendorLang))
    await notifyCustomerOrderPreparing(order.customer_phone, payload, restaurant.name, custLang)
  } else if (target === 'ready') {
    await sendWhatsApp(from,
      pickLang(`🎉 Commande #${upper} prête! Le client est notifié.`, `🎉 Order #${upper} is ready! Customer notified.`, vendorLang) + `\n\n` +
      pickLang(`💡 Envoyez 'recupere ${upper}' quand le client récupère sa commande.`, `💡 Send 'picked ${upper}' when the customer picks up.`, vendorLang))
    await notifyCustomerOrderReady(order.customer_phone, payload, restaurant.name, custLang)
  } else if (target === 'delivered') {
    await sendWhatsApp(from,
      pickLang(`📦 Commande #${upper} récupérée. Terminé!`, `📦 Order #${upper} picked up. Done!`, vendorLang))
    await notifyCustomerOrderDelivered(order.customer_phone, payload, restaurant.name, custLang)
  }
  return ok()
}
