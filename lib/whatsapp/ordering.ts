// WhatsApp ordering flow — customer-side state machine + vendor order actions.
// See docs/superpowers/specs/2026-04-18-whatsapp-ordering-design.md

import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { writeAudit } from '@/lib/audit'
import {
  sendWhatsApp,
  notifyCustomerOrderConfirmed,
  notifyCustomerOrderReady,
  notifyCustomerOrderCancelled,
} from '@/lib/whatsapp'

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
async function vendorRecipients(restaurantId: string): Promise<string[]> {
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

async function notifyVendorsOfNewOrder(
  restaurantId: string,
  restaurantName: string,
  orderId: string,
  customerName: string,
  customerPhone: string,
  items: CartItem[],
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

  if (cmd === 'mes commandes' || cmd === 'my orders') {
    const { data } = await supabaseAdmin
      .from('orders')
      .select('id, status, total_price, created_at, restaurants(name)')
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
      completed:  '🏁 Terminée / Completed',
      cancelled:  '❌ Annulée / Cancelled',
    }
    const lines = data.map((o, i) => {
      const rest = (o.restaurants as unknown as { name: string } | null)?.name ?? '—'
      const label = statusLabel[o.status] ?? o.status
      return `${i + 1}. #${last4(o.id)} - ${rest} - ${Number(o.total_price).toLocaleString()} FCFA - ${label}`
    })
    await sendWhatsApp(from, `📦 *Vos commandes / Your orders:*\n\n${lines.join('\n')}`)
    return ok()
  }

  return null
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

  // Step 3: waiting for oui/non
  if (step === 3) {
    if (cmd === 'oui' || cmd === 'yes' || cmd === 'ok') {
      const items = data.items ?? []
      const total = data.total ?? 0
      if (items.length === 0 || total <= 0) {
        await supabaseAdmin.from('signup_sessions').delete().eq('phone', phone)
        await sendWhatsApp(from, '❌ Commande invalide. Recommencez avec "commander". / Invalid order. Start again with "commander".')
        return ok()
      }

      const itemsJsonb = items.map(i => ({ name: i.name, price: i.price, quantity: i.quantity }))
      const { data: newOrder, error: orderErr } = await supabaseAdmin
        .from('orders')
        .insert({
          restaurant_id:  data.restaurant_id,
          customer_id:    customer.id,
          customer_name:  customer.name,
          customer_phone: customer.phone,
          items:          itemsJsonb,
          total_price:    total,
          status:         'pending',
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

      await writeAudit({
        action: 'order_created',
        targetType: 'order',
        targetId: newOrder.id,
        performedBy: customer.id,
        performedByType: 'customer',
        metadata: { restaurant_id: data.restaurant_id, total_price: total, item_count: items.length },
      })

      const id4 = last4(newOrder.id)
      await sendWhatsApp(from, [
        `✅ *Commande confirmée!*`,
        `🧾 Commande #${id4}`,
        `🏪 ${data.restaurant_name}`,
        `💰 Total: ${total.toLocaleString()} FCFA`,
        ``,
        `Le restaurant a été notifié. Vous recevrez un message quand votre commande sera prête!`,
        `The restaurant has been notified. You'll receive a message when your order is ready!`,
      ].join('\n'))

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

    await sendWhatsApp(from, 'Envoyez "oui" pour confirmer ou "non" pour annuler. / Send "yes" to confirm or "no" to cancel.')
    return ok()
  }

  // Unexpected step
  await supabaseAdmin.from('signup_sessions').delete().eq('phone', phone)
  await sendWhatsApp(from, 'Session expirée. Envoyez "aide". / Session expired. Send "help".')
  return ok()
}

// ── Public: vendor order actions (ok/pret/annuler XXXX) ──────────────────────
export async function handleVendorOrderAction(
  from: string,
  body: string,
  restaurant: { id: string; name: string },
): Promise<NextResponse | null> {
  const okMatch     = body.match(/^ok\s+([0-9a-f]{4})$/i)
  const readyMatch  = body.match(/^(?:pret|prêt|ready)\s+([0-9a-f]{4})$/i)
  const cancelMatch = body.match(/^(?:annuler|cancel)\s+([0-9a-f]{4})$/i)

  if (!okMatch && !readyMatch && !cancelMatch) return null

  const code4 = (okMatch?.[1] ?? readyMatch?.[1] ?? cancelMatch?.[1] ?? '').toLowerCase()
  const normalisedHex = code4

  const { data: orders } = await supabaseAdmin
    .from('orders')
    .select('id, status, customer_phone, customer_name, total_price, created_at, items')
    .eq('restaurant_id', restaurant.id)
    .not('status', 'in', '(completed,cancelled)')
    .order('created_at', { ascending: false })
    .limit(50)

  const matching = (orders ?? []).filter(o => o.id.replace(/-/g, '').toLowerCase().endsWith(normalisedHex))

  if (matching.length === 0) {
    await sendWhatsApp(from, `❌ Commande #${code4.toUpperCase()} introuvable pour ${restaurant.name}. / Order not found.`)
    return ok()
  }
  if (matching.length > 1) {
    await sendWhatsApp(from, `⚠️ Plusieurs commandes correspondent à #${code4.toUpperCase()}. Contactez le support. / Multiple orders match.`)
    return ok()
  }

  const order = matching[0]
  const payload = {
    id: order.id,
    customer_name: order.customer_name,
    customer_phone: order.customer_phone,
    items: (order.items as Array<{ name: string; quantity: number; price: number }>) ?? [],
    total_price: Number(order.total_price),
    created_at: order.created_at,
  }

  if (okMatch) {
    if (!['pending', 'confirmed'].includes(order.status)) {
      await sendWhatsApp(from, `Commande #${code4.toUpperCase()} déjà ${order.status}. / already ${order.status}.`)
      return ok()
    }
    await supabaseAdmin.from('orders').update({ status: 'confirmed', updated_at: new Date().toISOString() }).eq('id', order.id)
    await writeAudit({ action: 'order_confirmed', targetType: 'order', targetId: order.id, performedBy: restaurant.id, performedByType: 'vendor' })
    await sendWhatsApp(from, `✅ Commande #${code4.toUpperCase()} confirmée. Le client est notifié. / confirmed, customer notified.`)
    await notifyCustomerOrderConfirmed(order.customer_phone, payload, restaurant.name)
    return ok()
  }

  if (readyMatch) {
    if (!['confirmed', 'preparing', 'pending'].includes(order.status)) {
      await sendWhatsApp(from, `Commande #${code4.toUpperCase()} déjà ${order.status}. / already ${order.status}.`)
      return ok()
    }
    await supabaseAdmin.from('orders').update({ status: 'ready', updated_at: new Date().toISOString() }).eq('id', order.id)
    await writeAudit({ action: 'order_ready', targetType: 'order', targetId: order.id, performedBy: restaurant.id, performedByType: 'vendor' })
    await sendWhatsApp(from, `🎉 Commande #${code4.toUpperCase()} prête. Le client est notifié. / ready, customer notified.`)
    await notifyCustomerOrderReady(order.customer_phone, payload, restaurant.name)
    return ok()
  }

  // cancelMatch
  const { error: updErr } = await supabaseAdmin.from('orders').update({ status: 'cancelled', updated_at: new Date().toISOString() }).eq('id', order.id)
  if (updErr) {
    console.error('[ordering] cancel update failed — migration likely not applied:', updErr.message)
    await sendWhatsApp(from, `⚠️ Impossible d'annuler: migration manquante. Contactez le support. / Cannot cancel: migration not applied.`)
    return ok()
  }
  await writeAudit({ action: 'order_cancelled', targetType: 'order', targetId: order.id, performedBy: restaurant.id, performedByType: 'vendor' })
  await sendWhatsApp(from, `❌ Commande #${code4.toUpperCase()} annulée. Le client est notifié. / cancelled, customer notified.`)
  await notifyCustomerOrderCancelled(order.customer_phone, payload, restaurant.name)
  return ok()
}
