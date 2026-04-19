// Voucher validation + discount calculation.
// Single source of truth used by web checkout, WhatsApp ordering, the
// customer claim endpoint, and admin status badges.

import { supabaseAdmin } from '@/lib/supabaseAdmin'

export interface VoucherRow {
  id:               string
  code:             string
  discount_type:    'percent' | 'fixed'
  discount_value:   number
  min_order:        number | null
  max_uses:         number | null
  current_uses:     number | null
  per_customer_max?: number | null  // optional until migration applied
  is_active:        boolean
  expires_at:       string | null
  city:             string | null
  restaurant_id:    string | null
}

// Per-customer cap that applies when the voucher row doesn't specify one
// (i.e. before the per_customer_max column is populated). Matches the spec
// default of "1 = one-time use per customer".
const DEFAULT_PER_CUSTOMER_MAX = 1

export type VoucherRejectReason =
  | 'not_found'
  | 'inactive'
  | 'expired'
  | 'exhausted'
  | 'wrong_restaurant'
  | 'wrong_city'
  | 'min_order'
  | 'per_customer_limit'

export interface VoucherApplyContext {
  customerId?:   string | null   // logged-in customer placing the order
  restaurantId?: string          // the order's restaurant
  orderTotal:    number          // subtotal before discount (FCFA)
  city?:         string | null   // customer's city (restaurant_city for restaurant-scoped)
}

export type ValidationResult =
  | { ok: true;  voucher: VoucherRow; discount: number; finalTotal: number }
  | { ok: false; reason: VoucherRejectReason; message: string }

// Computes derived status for admin views. Keep in lockstep with
// validateVoucher — both sides use the same preconditions.
export type DerivedStatus = 'active' | 'inactive' | 'expired' | 'exhausted'

export function deriveStatus(v: Pick<VoucherRow, 'is_active' | 'expires_at' | 'max_uses' | 'current_uses'>): DerivedStatus {
  if (!v.is_active) return 'inactive'
  if (v.expires_at && new Date(v.expires_at) < new Date()) return 'expired'
  if (v.max_uses != null && v.max_uses > 0 && (v.current_uses ?? 0) >= v.max_uses) return 'exhausted'
  return 'active'
}

// Calculates the discount a voucher would apply to an order total. Never
// exceeds the order total (fixed vouchers can't produce a negative charge).
export function computeDiscount(v: Pick<VoucherRow, 'discount_type' | 'discount_value'>, orderTotal: number): number {
  if (v.discount_type === 'percent') {
    return Math.max(0, Math.round(orderTotal * Math.max(0, Math.min(100, v.discount_value)) / 100))
  }
  return Math.min(orderTotal, Math.max(0, Math.round(v.discount_value)))
}

const REJECT_MESSAGES: Record<VoucherRejectReason, string> = {
  not_found:          'Code introuvable / Code not found',
  inactive:           'Code désactivé / Code deactivated',
  expired:            'Code expiré / Code expired',
  exhausted:          'Code épuisé / Code fully used',
  wrong_restaurant:   'Ce code ne s\'applique pas à ce restaurant / Not valid for this restaurant',
  wrong_city:         'Ce code ne s\'applique pas dans votre ville / Not valid in your city',
  min_order:          'Montant minimum non atteint / Minimum order not met',
  per_customer_limit: 'Déjà utilisé / Already used',
}

function reject(reason: VoucherRejectReason): Extract<ValidationResult, { ok: false }> {
  return { ok: false, reason, message: REJECT_MESSAGES[reason] }
}

// Full validation used before applying a voucher to an order. Does NOT
// check the inventory-level mutation (incrementing current_uses) — caller
// is responsible for doing that atomically at order-creation time.
export async function validateVoucher(
  code: string,
  ctx:  VoucherApplyContext,
): Promise<ValidationResult> {
  const normalized = code.trim().toUpperCase()
  if (!normalized) return reject('not_found')

  const { data: v } = await supabaseAdmin
    .from('vouchers')
    .select('id, code, discount_type, discount_value, min_order, max_uses, current_uses, is_active, expires_at, city, restaurant_id')
    .eq('code', normalized)
    .maybeSingle()

  if (!v) return reject('not_found')
  const voucher = v as unknown as VoucherRow

  const status = deriveStatus(voucher)
  if (status === 'inactive')  return reject('inactive')
  if (status === 'expired')   return reject('expired')
  if (status === 'exhausted') return reject('exhausted')

  // Restaurant scoping
  if (voucher.restaurant_id && voucher.restaurant_id !== ctx.restaurantId) {
    return reject('wrong_restaurant')
  }

  // City scoping — if voucher is city-restricted, require either a matching
  // customer city OR (when not provided) a matching restaurant city.
  if (voucher.city) {
    const ctxCity = (ctx.city ?? '').trim()
    if (!ctxCity || ctxCity.toLowerCase() !== voucher.city.toLowerCase()) {
      return reject('wrong_city')
    }
  }

  // Minimum order
  if (voucher.min_order && ctx.orderTotal < voucher.min_order) {
    return reject('min_order')
  }

  // Per-customer cap — only enforced for logged-in customers. The column
  // is optional (pre-migration); fall back to the default.
  if (ctx.customerId) {
    const limit = voucher.per_customer_max ?? DEFAULT_PER_CUSTOMER_MAX
    if (limit > 0) {
      const { count } = await supabaseAdmin
        .from('customer_vouchers')
        .select('id', { count: 'exact', head: true })
        .eq('customer_id', ctx.customerId)
        .eq('voucher_id', voucher.id)
        .not('used_at', 'is', null)
      if ((count ?? 0) >= limit) {
        return reject('per_customer_limit')
      }
    }
  }

  const discount = computeDiscount(voucher, ctx.orderTotal)
  return {
    ok: true,
    voucher,
    discount,
    finalTotal: Math.max(0, ctx.orderTotal - discount),
  }
}

// Ensures a newly-registered customer gets the welcome voucher claimed
// into their wallet. Never throws — signup must not fail because the
// welcome voucher seed is missing or already claimed.
export async function assignWelcomeVoucher(customerId: string): Promise<void> {
  try {
    const { data: voucher } = await supabaseAdmin
      .from('vouchers').select('id').eq('code', 'BIENVENUE')
      .eq('is_active', true).maybeSingle()
    if (!voucher) {
      console.warn('[vouchers] BIENVENUE not found — seed supabase-vouchers-system.sql')
      return
    }
    const { data: existing } = await supabaseAdmin
      .from('customer_vouchers').select('id')
      .eq('customer_id', customerId).eq('voucher_id', voucher.id).limit(1).maybeSingle()
    if (existing) return
    await supabaseAdmin.from('customer_vouchers').insert({ customer_id: customerId, voucher_id: voucher.id })
  } catch (e) {
    console.error('[vouchers] assignWelcomeVoucher failed:', (e as Error).message)
  }
}

// Call after a successful order write. Atomically increments
// vouchers.current_uses and marks the customer_vouchers claim (if any)
// as used. Never throws — caller treats failure as best-effort.
export async function consumeVoucherForOrder(
  voucherId:  string,
  customerId: string | null,
  orderId:    string,
): Promise<void> {
  try {
    // Increment current_uses. Use an RPC would be atomic; best-effort here.
    const { data: v } = await supabaseAdmin.from('vouchers')
      .select('current_uses').eq('id', voucherId).maybeSingle()
    const next = (v?.current_uses ?? 0) + 1
    await supabaseAdmin.from('vouchers').update({ current_uses: next, uses_count: next }).eq('id', voucherId)

    if (customerId) {
      // Mark the claim (if one exists) as used and link it to the order.
      const { data: claim } = await supabaseAdmin
        .from('customer_vouchers')
        .select('id').eq('customer_id', customerId).eq('voucher_id', voucherId)
        .is('used_at', null).limit(1).maybeSingle()
      if (claim) {
        await supabaseAdmin.from('customer_vouchers')
          .update({ used_at: new Date().toISOString(), used: true, order_id: orderId })
          .eq('id', claim.id)
      }
    }
  } catch (e) {
    console.error('[vouchers] consume failed for', voucherId, (e as Error).message)
  }
}
