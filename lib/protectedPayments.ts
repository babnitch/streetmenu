// Protected payments (Prompt P). Server-only.
//
// A restaurant's Mobile Money order is "protected" when the platform master
// switch is ON and the restaurant has the module "payments_protected" (which
// needs "payment"). Then the money it paid is HELD by Tchop & Ndjoka
// (orders.funds_status = 'held' + one money_ledger line) until the order is
// handed over, and only then becomes the restaurant's available balance.
// Switch OFF or module OFF: funds_status stays NULL and nothing changes.
//
// Every money move is one SQL function (supabase-protected-payments.sql)
// that claims the order's state and writes its ledger lines once; this file
// only decides WHEN to call them.
//
// Test money is never real money: test data (+999, fake test city) and
// everything paid while PawaPay runs in SANDBOX is is_test (orders.is_test,
// pro_payouts.is_test), so it never counts in a real balance or payout.

import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { writeAudit } from '@/lib/audit'
import { restaurantModules } from '@/lib/modulesServer'
import { pawapayEnvironmentLabel } from '@/lib/pawapay'
import { testGuardPrefix } from '@/lib/testGuard'
import { deliveryCode } from '@/lib/scanTokens'

export type FundsStatus = 'held' | 'released' | 'refunding' | 'refunded' | 'disputed'

export interface ProtectedSettings {
  master: boolean
  acceptTimeoutMin: number
  autoReleaseHours: number
  codeMaxTries: number
  commissionOrderPct: number
}

// The master switch has its own row under the local test server (like the
// platform switches), so a test that turns it on can never turn it on live.
const MASTER_KEY = `${testGuardPrefix() ? 'test_' : ''}payments_protected_master`
const KEYS = {
  acceptTimeoutMin:   'protected_accept_timeout_min',
  autoReleaseHours:   'protected_auto_release_hours',
  codeMaxTries:       'protected_code_max_tries',
  commissionOrderPct: 'commission_order_pct',
} as const
export const PROTECTED_DEFAULTS: ProtectedSettings = {
  master: false, acceptTimeoutMin: 15, autoReleaseHours: 24, codeMaxTries: 5, commissionOrderPct: 0,
}
// Allowed ranges for the admin form (and the API check).
export const PROTECTED_LIMITS: Record<Exclude<keyof ProtectedSettings, 'master'>, [number, number]> = {
  acceptTimeoutMin: [5, 120], autoReleaseHours: [1, 168], codeMaxTries: [3, 10], commissionOrderPct: [0, 30],
}

const TTL_MS = 30_000
let cache: { at: number; value: ProtectedSettings } | null = null

export async function getProtectedSettings(): Promise<ProtectedSettings> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value
  const { data, error } = await supabaseAdmin.from('platform_settings')
    .select('key, value').in('key', [MASTER_KEY, ...Object.values(KEYS)])
  // Unreadable settings → OFF: never hold money on a guess.
  if (error) return { ...PROTECTED_DEFAULTS }
  const get = (k: string) => (data ?? []).find(r => r.key === k)?.value
  const num = (k: string, d: number) => { const v = Number(get(k)); return Number.isFinite(v) ? v : d }
  const value: ProtectedSettings = {
    master:             get(MASTER_KEY) === true,
    acceptTimeoutMin:   num(KEYS.acceptTimeoutMin, PROTECTED_DEFAULTS.acceptTimeoutMin),
    autoReleaseHours:   num(KEYS.autoReleaseHours, PROTECTED_DEFAULTS.autoReleaseHours),
    codeMaxTries:       num(KEYS.codeMaxTries, PROTECTED_DEFAULTS.codeMaxTries),
    commissionOrderPct: num(KEYS.commissionOrderPct, PROTECTED_DEFAULTS.commissionOrderPct),
  }
  cache = { at: Date.now(), value }
  return value
}

export function clearProtectedSettingsCache(): void { cache = null }

// Admin → Plateforme → "Paiements protégés" (super admin). Audited.
export async function setProtectedSettings(patch: Partial<ProtectedSettings>, admin: { id: string; type: string }): Promise<ProtectedSettings> {
  const before = await getProtectedSettings()
  const rows: Array<{ key: string; value: unknown; updated_at: string }> = []
  const now = new Date().toISOString()
  if (typeof patch.master === 'boolean') rows.push({ key: MASTER_KEY, value: patch.master, updated_at: now })
  for (const k of Object.keys(KEYS) as Array<keyof typeof KEYS>) {
    if (patch[k] === undefined) continue
    const [lo, hi] = PROTECTED_LIMITS[k]
    const v = Number(patch[k])
    if (!Number.isFinite(v) || v < lo || v > hi) throw new Error(`${k}: ${lo}–${hi}`)
    rows.push({ key: KEYS[k], value: k === 'commissionOrderPct' ? Math.round(v * 10) / 10 : Math.round(v), updated_at: now })
  }
  if (rows.length) {
    const { error } = await supabaseAdmin.from('platform_settings').upsert(rows, { onConflict: 'key' })
    if (error) throw new Error(error.message)
  }
  cache = null
  const after = await getProtectedSettings()
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    await writeAudit({
      action: 'protected_payments_settings', targetType: 'platform', targetId: '00000000-0000-0000-0000-00000000a003',
      performedBy: admin.id, performedByType: admin.type, previousData: { ...before }, metadata: { ...after },
    })
  }
  return after
}

// Money paid while PawaPay runs in SANDBOX is test money, whoever paid.
export function isSandboxMoney(): boolean {
  return pawapayEnvironmentLabel() !== 'production'
}

export async function isProtectedRestaurant(restaurantId: string): Promise<boolean> {
  const s = await getProtectedSettings()
  if (!s.master) return false
  const mods = await restaurantModules(restaurantId)
  return mods.includes('payments_protected') && mods.includes('payment')
}

// The customer's hand-over code: the existing delivery code (HMAC of the
// order id, never stored). Shown to that customer only.
export function handoverCode(orderId: string): string {
  return deliveryCode(orderId)
}

export function isHeldStatus(s: string | null | undefined): boolean {
  return s === 'held' || s === 'disputed'
}

export type HoldResult = 'held' | 'not_protected' | 'already' | 'error'

// Called once, by the winner of the payment claim (settleOrder). Holds what
// was paid; the restaurant must accept before accept_deadline.
export async function holdOrderFunds(orderId: string, paidAmount?: string | number | null): Promise<HoldResult> {
  const { data: o } = await supabaseAdmin.from('orders')
    .select('id, restaurant_id, total_price, payment_status, funds_status, order_type').eq('id', orderId).maybeSingle()
  if (!o || o.order_type !== 'paid_order' || o.payment_status !== 'paid') return 'not_protected'
  if (o.funds_status) return 'already'
  if (!(await isProtectedRestaurant(o.restaurant_id as string))) return 'not_protected'

  const paid = Number(paidAmount)
  const amount = Math.round(Number.isFinite(paid) && paid > 0 ? paid : Number(o.total_price))
  if (!(amount > 0)) return 'not_protected'
  const s = await getProtectedSettings()
  const deadline = new Date(Date.now() + s.acceptTimeoutMin * 60_000).toISOString()
  try {
    if (isSandboxMoney()) {
      const { error } = await supabaseAdmin.from('orders').update({ is_test: true }).eq('id', orderId)
      if (error) throw new Error(`is_test: ${error.message}`)
    }
    const { data, error } = await supabaseAdmin.rpc('order_funds_hold', { p_order: orderId, p_amount: amount, p_deadline: deadline })
    if (error) throw new Error(error.message)
    if (data !== true) return 'already'
  } catch (e) {
    // Loud: a protected payment that is not held is paid out by hand, as today.
    console.error('[protected] HOLD FAILED order=%s: %s', orderId, (e as Error).message)
    await writeAudit({ action: 'funds_hold_failed', targetType: 'order', targetId: orderId, performedByType: 'system', metadata: { error: (e as Error).message, amount } })
    return 'error'
  }
  await writeAudit({
    action: 'funds_held', targetType: 'order', targetId: orderId, performedByType: 'system',
    metadata: { amount, accept_deadline: deadline, sandbox: isSandboxMoney() },
  })
  return 'held'
}
