// Riders (Q5). Optional, per restaurant (restaurants.riders_mode):
//   'none' (default) — riders are not on the app; deliveries are confirmed
//                      by the customer, the code, or the restaurant (Q2)
//   'app'            — riders have accounts (restaurant_riders) and see ONLY
//                      the orders assigned to them ("Mes livraisons"): no
//                      menu, settings, team, money or other orders. Their one
//                      action: scan the customer's QR or type the customer's
//                      delivery code → "Livrée" (delivered_confirmed_by =
//                      rider, delivered_by_rider).
// Server-only.

import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { formatFCFA } from '@/lib/money'
import { orderCode } from '@/lib/shortCode'
import { pickLang, type Lang } from '@/lib/whatsapp'
import { SITE_URL } from '@/lib/siteLinks'

export type RidersMode = 'none' | 'app'
export const OPEN_FOR_RIDER = ['confirmed', 'preparing', 'ready', 'out_for_delivery'] as const

export interface RiderRow { id: string; restaurant_id: string; customer_id: string; name: string; phone: string }

export async function listRiders(restaurantId: string): Promise<RiderRow[]> {
  const { data } = await supabaseAdmin.from('restaurant_riders')
    .select('id, restaurant_id, customer_id, customers!restaurant_riders_customer_id_fkey(name, phone)')
    .eq('restaurant_id', restaurantId).eq('status', 'active').order('created_at', { ascending: true })
  return ((data ?? []) as unknown as Array<{ id: string; restaurant_id: string; customer_id: string; customers: { name: string; phone: string } | null }>)
    .map(r => ({ id: r.id, restaurant_id: r.restaurant_id, customer_id: r.customer_id, name: r.customers?.name ?? '', phone: r.customers?.phone ?? '' }))
}

// The rider rows (one per restaurant) of a logged-in account.
export async function riderRowsOf(customerId: string): Promise<Array<{ id: string; restaurant_id: string }>> {
  const { data } = await supabaseAdmin.from('restaurant_riders').select('id, restaurant_id')
    .eq('customer_id', customerId).eq('status', 'active')
  return (data ?? []) as Array<{ id: string; restaurant_id: string }>
}

// Is this account the rider assigned to this order? → the rider row id.
export async function assignedRiderId(order: { rider_id?: string | null }, customerId: string): Promise<string | null> {
  if (!order.rider_id) return null
  const { data } = await supabaseAdmin.from('restaurant_riders').select('id')
    .eq('id', order.rider_id).eq('customer_id', customerId).eq('status', 'active').maybeSingle()
  return (data?.id as string | undefined) ?? null
}

export interface RiderOrder {
  id: string; restaurant_id: string; customer_name: string | null; customer_phone: string | null
  items: unknown; total_price: number; delivery_fee: number | null; delivery_address: string | null
  delivery_landmark: string | null; delivery_phone: string | null; order_type: string | null; payment_status: string | null
}

// What the rider collects in cash: nothing if paid online, else the total.
export function cashToCollect(o: Pick<RiderOrder, 'order_type' | 'payment_status' | 'total_price'>): number {
  return o.order_type === 'paid_order' && o.payment_status === 'paid' ? 0 : Number(o.total_price || 0)
}

// The one WhatsApp a rider gets when an order is assigned. The ORDER number
// (#AB12) only — never the customer's secret delivery code.
export function riderAssignmentMessage(o: RiderOrder, restaurantName: string, lang: Lang): string {
  const items = Array.isArray(o.items) ? (o.items as Array<{ name: string; quantity: number }>) : []
  const cash = cashToCollect(o)
  const phone = o.delivery_phone || o.customer_phone
  return [
    pickLang(`🛵 *Livraison #${orderCode(o.id)}* — ${restaurantName}`, `🛵 *Delivery #${orderCode(o.id)}* — ${restaurantName}`, lang),
    ...items.map(i => `  • ${i.quantity}× ${i.name}`),
    o.delivery_address ? `📍 ${o.delivery_address}` : '',
    o.delivery_landmark ? `🧭 ${o.delivery_landmark}` : '',
    phone ? `📞 ${o.customer_name ? `${o.customer_name} — ` : ''}${phone}` : '',
    cash > 0
      ? pickLang(`💵 À encaisser : *${formatFCFA(cash)}*`, `💵 Cash to collect: *${formatFCFA(cash)}*`, lang)
      : pickLang(`✅ Déjà payé en ligne`, `✅ Already paid online`, lang),
    ``,
    pickLang(
      `À la remise : scannez le QR du client ou tapez son code de livraison.\nMes livraisons : ${SITE_URL}/livraisons`,
      `On delivery: scan the customer's QR or type their delivery code.\nMy deliveries: ${SITE_URL}/livraisons`, lang),
  ].filter(Boolean).join('\n')
}
