// The server's price for a restaurant order (V0).
//
// The browser sends which dishes and how many; everything with money in it
// comes from the database here: each dish's price, availability, and the
// voucher. The checkout's own total is only compared against the result —
// when they differ the order is refused and the current prices go back so
// the cart can update.
//
// Delivery (V1): the restaurant's own fee is added after the voucher —
// vouchers apply to the food, never to the delivery fee.

import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { validateVoucher, type VoucherRow } from '@/lib/vouchers'
import { DELIVERY_OFF_TEXT, type Fulfilment } from '@/lib/delivery'

export interface PricedLine { id: string; name: string; price: number; quantity: number; photo_url: string | null }

export type OrderPricing =
  | {
      ok: true
      lines: PricedLine[]
      subtotal: number
      discount: number
      deliveryFee: number
      total: number
      voucher: Pick<VoucherRow, 'id' | 'code'> | null
    }
  | { ok: false; status: number; error: string; reason: string; current?: Array<{ id: string; price: number; available: boolean }> }

export interface OrderPricingInput {
  restaurantId: string
  items: Array<{ id: string; quantity: number }>
  voucherCode: string | null
  customerId: string | null
  fulfilment?: Fulfilment
}

export async function priceOrder(input: OrderPricingInput): Promise<OrderPricing> {
  const { restaurantId, voucherCode, customerId } = input

  // Same dish twice in the request → one line with the quantities added.
  const qty = new Map<string, number>()
  for (const i of input.items) {
    if (!i.id) return { ok: false, status: 400, error: 'Plat inconnu / Unknown dish', reason: 'unknown_item' }
    qty.set(i.id, Math.min(99, (qty.get(i.id) ?? 0) + i.quantity))
  }
  if (qty.size === 0) return { ok: false, status: 400, error: 'items requis / required', reason: 'no_items' }

  const { data: rest } = await supabaseAdmin.from('restaurants')
    .select('id, delivery_enabled, delivery_fee').eq('id', restaurantId).maybeSingle()
  if (!rest) return { ok: false, status: 404, error: 'Restaurant introuvable / Restaurant not found', reason: 'no_restaurant' }
  const delivery = input.fulfilment === 'delivery'
  if (delivery && rest.delivery_enabled !== true) {
    return { ok: false, status: 409, error: DELIVERY_OFF_TEXT, reason: 'delivery_off' }
  }
  const deliveryFee = delivery ? Math.max(0, Math.round(Number(rest.delivery_fee ?? 0))) : 0

  const { data: rows, error } = await supabaseAdmin
    .from('menu_items')
    .select('id, name, price, photo_url, is_available')
    .eq('restaurant_id', restaurantId)
    .in('id', Array.from(qty.keys()))
  if (error) return { ok: false, status: 500, error: 'Erreur / Error', reason: 'lookup_failed' }
  const byId = new Map((rows ?? []).map(r => [r.id as string, r]))

  const current = Array.from(qty.keys()).map(id => {
    const r = byId.get(id)
    return { id, price: r ? Math.round(Number(r.price)) : 0, available: !!r && r.is_available !== false }
  })
  const missing = Array.from(qty.keys()).find(id => !byId.has(id))
  if (missing) {
    return { ok: false, status: 409, reason: 'unknown_item', current,
      error: 'Un plat n\'est plus au menu. Votre panier a été mis à jour. / A dish is no longer on the menu. Your cart was updated.' }
  }
  const gone = (rows ?? []).find(r => r.is_available === false)
  if (gone) {
    return { ok: false, status: 409, reason: 'sold_out', current,
      error: `Épuisé : ${gone.name} / Sold out: ${gone.name}` }
  }

  const lines: PricedLine[] = Array.from(qty.entries()).map(([id, quantity]) => {
    const r = byId.get(id)!
    return {
      id, quantity,
      name: String(r.name ?? '').slice(0, 120),
      price: Math.max(0, Math.round(Number(r.price))),
      photo_url: (r.photo_url as string | null) ?? null,
    }
  })
  const subtotal = lines.reduce((s, l) => s + l.price * l.quantity, 0)

  let discount = 0
  let voucher: Pick<VoucherRow, 'id' | 'code'> | null = null
  if (voucherCode) {
    // Same city rule as /api/customer/vouchers/apply.
    let city: string | null = null
    if (customerId) {
      const { data } = await supabaseAdmin.from('customers').select('city').eq('id', customerId).maybeSingle()
      city = data?.city ?? null
    }
    const v = await validateVoucher(voucherCode, { customerId, restaurantId, orderTotal: subtotal, city })
    if (!v.ok) return { ok: false, status: 422, error: v.message, reason: `voucher_${v.reason}` }
    discount = v.discount
    voucher = { id: v.voucher.id, code: v.voucher.code }
  }

  const total = Math.max(0, subtotal - discount) + deliveryFee
  return { ok: true, lines, subtotal, discount, deliveryFee, total, voucher }
}

export const PRICE_CHANGED_TEXT =
  'Les prix ont changé. Votre panier a été mis à jour, vérifiez le total. / Prices have changed. Your cart was updated, check the total.'
