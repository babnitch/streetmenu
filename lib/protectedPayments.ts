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
import { sendWhatsApp, getLangByPhone, pickLang } from '@/lib/whatsapp'
import { orderCommission } from '@/lib/commission'
import { formatFCFA } from '@/lib/money'
import { timingSafeEqual } from 'crypto'

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

// ── P1b: release ────────────────────────────────────────────────────────────
// Ways the money is released to the restaurant:
//   code      the restaurant types the customer's code for THAT order
//             (Valider → "En attente du code", or WhatsApp "CODE …")
//   rider     the assigned rider typed the code (or scanned the customer's QR)
//   customer  the customer confirms "Reçu / Received"
//   auto      handed over without a code, no problem within N hours
//   admin     an admin decides (problems, P1d)
// The code-only lookup of "Valider" (a code typed with no order) never
// releases money: a restaurant could try codes across orders.

export type ReleaseBy = 'code' | 'rider' | 'customer' | 'auto' | 'admin'
export interface Actor { id: string | null; type: string }

const last4 = (id: string) => id.replace(/-/g, '').slice(-4).toUpperCase()
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// What is still held for the restaurant on this order (ledger sum).
export async function heldAmount(orderId: string): Promise<number> {
  const { data } = await supabaseAdmin.from('money_ledger').select('delta')
    .eq('order_id', orderId).eq('party_type', 'restaurant').eq('bucket', 'held')
  return ((data ?? []) as Array<{ delta: number }>).reduce((a, r) => a + Number(r.delta), 0)
}

async function hasOpenProblem(orderId: string): Promise<boolean> {
  const { count } = await supabaseAdmin.from('order_problems').select('id', { count: 'exact', head: true })
    .eq('order_id', orderId).eq('status', 'open')
  return (count ?? 0) > 0
}

export async function alertAdmins(fr: string, en: string, relatedId: string): Promise<void> {
  const { data: admins } = await supabaseAdmin.from('admin_users').select('phone')
    .in('role', ['super_admin', 'admin']).eq('status', 'active').not('phone', 'is', null)
  await Promise.allSettled((admins ?? []).map(async a => {
    const lang = await getLangByPhone(a.phone as string)
    return sendWhatsApp(a.phone as string, pickLang(fr, en, lang), { context: 'account_notice', relatedId })
  }))
}

async function tellRestaurant(restaurantId: string, orderId: string, fr: string, en: string): Promise<void> {
  const { vendorRecipients } = await import('@/lib/whatsapp/ordering')
  for (const p of await vendorRecipients(restaurantId)) {
    await sendWhatsApp(p, pickLang(fr, en, await getLangByPhone(p)), { context: 'payment_confirmation', relatedId: orderId }).catch(() => null)
  }
}

export type ReleaseResult =
  | { ok: true; amount: number; commission: number }
  | { ok: false; reason: 'not_held' | 'problem_open' | 'error'; error: string }

export async function releaseOrderFunds(orderId: string, by: ReleaseBy, actor: Actor | null = null): Promise<ReleaseResult> {
  const { data: o } = await supabaseAdmin.from('orders').select('id, restaurant_id, funds_status').eq('id', orderId).maybeSingle()
  if (!o || !isHeldStatus(o.funds_status as string)) return { ok: false, reason: 'not_held', error: 'Paiement non retenu / Payment not held' }
  // A reported problem keeps the money held: only an admin decides.
  if (by !== 'admin' && (o.funds_status === 'disputed' || await hasOpenProblem(orderId))) {
    return { ok: false, reason: 'problem_open', error: 'Problème signalé : Tchop & Ndjoka décide / Problem reported: Tchop & Ndjoka decides' }
  }
  const held = await heldAmount(orderId)
  const commission = orderCommission(held, (await getProtectedSettings()).commissionOrderPct)
  const actorId = actor?.id && UUID_RE.test(actor.id) ? actor.id : null
  const { data, error } = await supabaseAdmin.rpc('order_funds_release', { p_order: orderId, p_by: by, p_commission: commission, p_actor: actorId })
  if (error) {
    console.error('[protected] RELEASE FAILED order=%s: %s', orderId, error.message)
    return { ok: false, reason: 'error', error: 'Erreur — réessayez / Error — please try again' }
  }
  if (data !== true) return { ok: false, reason: 'not_held', error: 'Déjà versé / Already paid out' }
  await writeAudit({
    action: 'funds_released', targetType: 'order', targetId: orderId,
    performedBy: actorId, performedByType: by === 'auto' ? 'system' : actor?.type ?? 'system',
    metadata: { by, amount: held - commission, commission, held },
  })
  // A problem reported at the same moment as a release: tell the admins.
  if (by !== 'admin' && await hasOpenProblem(orderId)) {
    await alertAdmins(`⚠️ Commande #${last4(orderId)} : paiement versé alors qu'un problème venait d'être signalé. À vérifier.`,
      `⚠️ Order #${last4(orderId)}: payment released just as a problem was reported. Please check.`, orderId)
  }
  const net = held - commission
  await tellRestaurant(o.restaurant_id as string, orderId,
    `💰 Commande #${last4(orderId)} : ${formatFCFA(net)} ajoutés à votre solde${commission ? ` (commission ${formatFCFA(commission)})` : ''}.`,
    `💰 Order #${last4(orderId)}: ${formatFCFA(net)} added to your balance${commission ? ` (commission ${formatFCFA(commission)})` : ''}.`)
  return { ok: true, amount: net, commission }
}

// After an order is marked delivered / collected, whoever did it.
//   proof (rider with code, customer "Reçu", code typed for this order) →
//     released now;
//   no proof (dashboard "Livrée", WhatsApp "livre", QR or code lookup) →
//     the customer is told, and it is released automatically after
//     autoReleaseHours unless they report a problem.
export async function afterHandover(orderId: string, by: string, actor: Actor | null, codeChecked = false): Promise<void> {
  try {
    const { data: o } = await supabaseAdmin.from('orders')
      .select('id, funds_status, customer_phone, fulfilment').eq('id', orderId).maybeSingle()
    if (!o || o.funds_status !== 'held') return
    if (codeChecked || by === 'rider' || by === 'customer') {
      await releaseOrderFunds(orderId, codeChecked ? 'code' : (by as ReleaseBy), actor)
      return
    }
    if (!o.customer_phone) return
    const hours = (await getProtectedSettings()).autoReleaseHours
    const lang = await getLangByPhone(o.customer_phone as string)
    const delivery = o.fulfilment === 'delivery'
    await sendWhatsApp(o.customer_phone as string, pickLang(
      `Votre commande #${last4(orderId)} est marquée ${delivery ? 'livrée' : 'récupérée'}. Un problème ? Répondez "probleme" dans les ${hours} h, sinon le paiement est versé au restaurant.`,
      `Your order #${last4(orderId)} is marked ${delivery ? 'delivered' : 'collected'}. A problem? Reply "problem" within ${hours} h, otherwise the payment goes to the restaurant.`,
      lang), { context: 'order_status_update', relatedId: orderId })
  } catch (e) {
    console.error('[protected] afterHandover %s: %s', orderId, (e as Error).message)
  }
}

// ── The code, typed for ONE order ───────────────────────────────────────────
export const RESTAURANT_WRONG_CODES_PER_HOUR = 20

function sameCode(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

export type CodeResult =
  | { ok: true; amount: number; commission: number }
  | { ok: false; status: number; reason: string; error: string; triesLeft?: number }

export async function releaseWithCode(orderId: string, rawCode: string, actor: Actor, via: 'app' | 'whatsapp'): Promise<CodeResult> {
  const { data: o } = await supabaseAdmin.from('orders')
    .select('id, restaurant_id, status, funds_status, release_attempts, release_locked_at').eq('id', orderId).maybeSingle()
  if (!o) return { ok: false, status: 404, reason: 'not_found', error: 'Commande introuvable / Order not found' }
  if (o.funds_status === 'disputed') return { ok: false, status: 409, reason: 'problem_open', error: 'Problème signalé : Tchop & Ndjoka décide / Problem reported: Tchop & Ndjoka decides' }
  if (o.funds_status !== 'held') return { ok: false, status: 409, reason: 'not_held', error: 'Aucun paiement retenu pour cette commande / No payment held for this order' }
  if (o.status === 'cancelled' || o.status === 'pending') {
    return { ok: false, status: 409, reason: 'not_accepted', error: 'Commande pas acceptée ou annulée / Order not accepted or cancelled' }
  }
  if (o.release_locked_at) {
    return { ok: false, status: 423, reason: 'locked', error: 'Bloquée après trop de codes faux — Tchop & Ndjoka vous contacte / Locked after too many wrong codes — Tchop & Ndjoka will contact you' }
  }
  const since = new Date(Date.now() - 3600_000).toISOString()
  const { count: wrongLastHour } = await supabaseAdmin.from('audit_log').select('id', { count: 'exact', head: true })
    .eq('action', 'release_code_wrong').eq('metadata->>restaurant_id', o.restaurant_id as string).gte('created_at', since)
  if ((wrongLastHour ?? 0) >= RESTAURANT_WRONG_CODES_PER_HOUR) {
    return { ok: false, status: 429, reason: 'restaurant_capped', error: 'Trop de codes faux cette heure — réessayez plus tard / Too many wrong codes this hour — try again later' }
  }

  const code = String(rawCode ?? '').replace(/\D/g, '')
  if (!sameCode(code, handoverCode(orderId))) {
    const max = (await getProtectedSettings()).codeMaxTries
    // One try more, counted atomically (a concurrent wrong code retries).
    let tries = Number(o.release_attempts ?? 0)
    for (let i = 0; i < 5; i++) {
      const next = tries + 1
      const { data: upd } = await supabaseAdmin.from('orders')
        .update({ release_attempts: next, ...(next >= max ? { release_locked_at: new Date().toISOString() } : {}) })
        .eq('id', orderId).eq('release_attempts', tries).select('release_attempts')
      if ((upd ?? []).length) { tries = next; break }
      const { data: again } = await supabaseAdmin.from('orders').select('release_attempts').eq('id', orderId).single()
      tries = Number(again?.release_attempts ?? tries + 1)
    }
    await writeAudit({
      action: 'release_code_wrong', targetType: 'order', targetId: orderId,
      performedBy: actor.id && UUID_RE.test(actor.id) ? actor.id : null, performedByType: actor.type,
      metadata: { restaurant_id: o.restaurant_id, tries, via },
    })
    if (tries >= max) {
      await writeAudit({ action: 'release_code_locked', targetType: 'order', targetId: orderId, performedByType: 'system', metadata: { restaurant_id: o.restaurant_id, tries } })
      await alertAdmins(
        `🔒 Commande #${last4(orderId)} bloquée : ${tries} codes de remise faux. L'argent reste retenu. Admin → Commandes.`,
        `🔒 Order #${last4(orderId)} locked: ${tries} wrong hand-over codes. The money stays held. Admin → Orders.`, orderId)
      return { ok: false, status: 423, reason: 'locked', error: 'Bloquée après trop de codes faux — Tchop & Ndjoka vous contacte / Locked after too many wrong codes — Tchop & Ndjoka will contact you', triesLeft: 0 }
    }
    return { ok: false, status: 400, reason: 'wrong_code', error: `Code faux — demandez le code au client (${max - tries} essai(s) restant(s)) / Wrong code — ask the customer (${max - tries} try/tries left)`, triesLeft: max - tries }
  }

  // Right code: the hand-over happened. Mark it (if not yet), then release.
  if (o.status !== 'delivered' && o.status !== 'completed') {
    const { markOrderDelivered } = await import('@/lib/orderDelivery')
    const m = await markOrderDelivered(orderId, 'restaurant_code', { id: actor.id, type: actor.type === 'admin' ? 'admin' : 'customer' }, { notify: 'customer', skipFunds: true })
    if (!m.ok && m.reason !== 'already') return { ok: false, status: 409, reason: 'refused', error: m.error }
  }
  const r = await releaseOrderFunds(orderId, 'code', actor)
  if (!r.ok) return { ok: false, status: r.reason === 'error' ? 500 : 409, reason: r.reason, error: r.error }
  return r
}

// Orders waiting for their code (Valider → "En attente du code"; WhatsApp CODE).
export interface AwaitingOrder { id: string; code4: string; customer_name: string | null; total_price: number; status: string; fulfilment: string | null; locked: boolean; created_at: string }

export async function ordersAwaitingCode(restaurantId: string): Promise<AwaitingOrder[]> {
  const { data } = await supabaseAdmin.from('orders')
    .select('id, customer_name, total_price, status, fulfilment, release_locked_at, created_at')
    .eq('restaurant_id', restaurantId).eq('funds_status', 'held').not('status', 'in', '(pending,cancelled)')
    .order('created_at', { ascending: false }).limit(50)
  return ((data ?? []) as Array<Record<string, unknown>>).map(r => ({
    id: r.id as string, code4: last4(r.id as string), customer_name: (r.customer_name as string | null) ?? null,
    total_price: Number(r.total_price), status: r.status as string, fulfilment: (r.fulfilment as string | null) ?? null,
    locked: !!r.release_locked_at, created_at: r.created_at as string,
  }))
}

// ── Auto-release (reconcile cron, every ~10 min) ────────────────────────────
// Handed over without a code, no problem reported within autoReleaseHours.
export async function autoReleaseDue(now = Date.now(), onlyIds?: string[]): Promise<{ checked: number; released: number }> {
  const hours = (await getProtectedSettings()).autoReleaseHours
  let q = supabaseAdmin.from('orders').select('id')
    .eq('funds_status', 'held').in('status', ['delivered', 'completed'])
    .lte('delivered_at', new Date(now - hours * 3600_000).toISOString())
    .order('delivered_at').limit(50)
  if (onlyIds) q = q.in('id', onlyIds)
  const { data } = await q
  const out = { checked: 0, released: 0 }
  for (const r of (data ?? []) as Array<{ id: string }>) {
    out.checked++
    const res = await releaseOrderFunds(r.id, 'auto', null)
    if (res.ok) out.released++
  }
  if (out.checked) console.log(`[protected] auto-release ${JSON.stringify(out)}`)
  return out
}

// ── P1c: automatic refunds ─────────────────────────────────────────────────
// The restaurant rejects or cancels a protected order, or doesn't accept it
// in time → the whole held amount goes back to the customer (the platform
// pays the refund fee). funds_status: held → refunding → refunded (ledger on
// completion, lib/refunds.ts → onRefundSettled). A refund PawaPay refuses
// leaves it 'disputed' and the admins are alerted.

export type RefundWhy = 'rejected' | 'cancelled' | 'accept_timeout'

const WHY_TEXT: Record<RefundWhy, { fr: string; en: string }> = {
  rejected:       { fr: 'Commande refusée par le restaurant', en: 'Order declined by the restaurant' },
  cancelled:      { fr: 'Commande annulée par le restaurant', en: 'Order cancelled by the restaurant' },
  accept_timeout: { fr: 'Commande pas acceptée à temps',      en: 'Order not accepted in time' },
}

// held / disputed → refunding (start of any refund of a protected order).
export async function fundsRefunding(orderId: string): Promise<void> {
  await supabaseAdmin.from('orders').update({ funds_status: 'refunding' }).eq('id', orderId).in('funds_status', ['held', 'disputed'])
}

export type AutoRefundResult = { ok: true; refundId: string; amount: number } | { ok: false; reason: string; error: string }

export async function refundHeldOrder(orderId: string, why: RefundWhy, actor: Actor | null): Promise<AutoRefundResult> {
  const { data: o } = await supabaseAdmin.from('orders').select('id, funds_status, customer_phone').eq('id', orderId).maybeSingle()
  if (!o || o.funds_status !== 'held') return { ok: false, reason: 'not_held', error: 'Paiement non retenu / Payment not held' }
  const amount = await heldAmount(orderId)
  if (!(amount > 0)) return { ok: false, reason: 'nothing_held', error: 'Rien à rembourser / Nothing to refund' }
  const { startRefund } = await import('@/lib/refunds')
  const t = WHY_TEXT[why]
  const r = await startRefund({
    kind: 'order', targetId: orderId, amount, reason: `${t.fr} / ${t.en}`, cancelAfter: true,
    adminId: actor?.id && UUID_RE.test(actor.id) ? actor.id : null, adminRole: actor?.type ?? 'system',
  })
  await writeAudit({
    action: r.ok ? 'funds_refund_started' : 'funds_refund_start_failed', targetType: 'order', targetId: orderId,
    performedByType: actor?.type ?? 'system', metadata: { why, amount, refund_id: r.ok ? r.refund.id : r.refund?.id ?? null, error: r.ok ? null : r.error },
  })
  if (!r.ok) {
    // Still with us: an admin decides (Admin → Commandes → Problèmes).
    await supabaseAdmin.from('orders').update({ funds_status: 'disputed' }).eq('id', orderId).in('funds_status', ['held', 'refunding'])
    await alertAdmins(`⚠️ Remboursement automatique impossible — commande #${last4(orderId)} (${formatFCFA(amount)}) : ${r.error.split(' / ')[0]}. L'argent reste retenu.`,
      `⚠️ Automatic refund failed — order #${last4(orderId)} (${formatFCFA(amount)}): ${r.error.split(' / ').pop()}. The money stays held.`, orderId)
    return { ok: false, reason: r.reason ?? 'refund_failed', error: r.error }
  }
  if (o.customer_phone) {
    const lang = await getLangByPhone(o.customer_phone as string)
    await sendWhatsApp(o.customer_phone as string, pickLang(
      `💸 ${t.fr} (#${last4(orderId)}). Nous vous remboursons ${formatFCFA(amount)} sur votre Mobile Money. Vous recevrez un message quand c'est fait.`,
      `💸 ${t.en} (#${last4(orderId)}). We are refunding ${formatFCFA(amount)} to your Mobile Money. You'll get a message when it's done.`, lang),
      { context: 'payment_confirmation', relatedId: orderId }).catch(() => null)
  }
  return { ok: true, refundId: r.refund.id, amount }
}

// From lib/refunds.ts, once per refund (the settle winner).
export async function onRefundSettled(orderId: string, refundId: string, amount: number, outcome: 'completed' | 'failed'): Promise<void> {
  const { data: o } = await supabaseAdmin.from('orders').select('funds_status').eq('id', orderId).maybeSingle()
  if (!o?.funds_status) return
  if (outcome === 'failed') {
    // A refund an admin decided on a problem failed: the problem is open again.
    await supabaseAdmin.from('order_problems').update({ status: 'open', refund_id: null, resolved_at: null, resolved_by: null })
      .eq('refund_id', refundId).in('status', ['refunded', 'partly_refunded'])
    if (o.funds_status !== 'refunding') return
    await supabaseAdmin.from('orders').update({ funds_status: 'disputed' }).eq('id', orderId).eq('funds_status', 'refunding')
    await alertAdmins(`⚠️ Remboursement échoué — commande #${last4(orderId)} (${formatFCFA(amount)}). L'argent reste retenu : Admin → Commandes.`,
      `⚠️ Refund failed — order #${last4(orderId)} (${formatFCFA(amount)}). The money stays held: Admin → Orders.`, orderId)
    return
  }
  if (!['held', 'disputed', 'refunding'].includes(o.funds_status as string)) {
    // Already released to the restaurant: an admin settles it (P1d / P2).
    console.warn('[protected] refund %s completed on order %s whose funds are %s — ledger not changed', refundId, orderId, o.funds_status)
    return
  }
  const { data, error } = await supabaseAdmin.rpc('order_funds_refunded', { p_order: orderId, p_refund: refundId, p_amount: amount })
  if (error) {
    console.error('[protected] LEDGER REFUND FAILED order=%s refund=%s: %s', orderId, refundId, error.message)
    await alertAdmins(`⚠️ Remboursement #${last4(orderId)} : grand livre non mis à jour (${error.message}).`, `⚠️ Refund #${last4(orderId)}: ledger not updated (${error.message}).`, orderId)
    return
  }
  if (data === true) {
    await writeAudit({ action: 'funds_refunded', targetType: 'order', targetId: orderId, performedByType: 'system', metadata: { refund_id: refundId, amount } })
    // Problem decided "refund X, release the rest": the rest goes now.
    const { data: pr } = await supabaseAdmin.from('order_problems').select('id, resolved_by')
      .eq('refund_id', refundId).eq('status', 'partly_refunded').maybeSingle()
    if (pr) await releaseOrderFunds(orderId, 'admin', { id: (pr.resolved_by as string | null) ?? null, type: 'admin' })
  }
}

// Accept timeout: still "pending" after accept_deadline → cancelled + refunded.
export async function acceptTimeoutDue(now = Date.now(), onlyIds?: string[]): Promise<{ checked: number; cancelled: number }> {
  let q = supabaseAdmin.from('orders').select('id, restaurant_id')
    .eq('funds_status', 'held').eq('status', 'pending')
    .lte('accept_deadline', new Date(now).toISOString()).order('accept_deadline').limit(50)
  if (onlyIds) q = q.in('id', onlyIds)
  const { data } = await q
  const out = { checked: 0, cancelled: 0 }
  for (const r of (data ?? []) as Array<{ id: string; restaurant_id: string }>) {
    out.checked++
    const { data: won } = await supabaseAdmin.from('orders').update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('id', r.id).eq('status', 'pending').select('id')
    if (!(won ?? []).length) continue   // accepted meanwhile
    out.cancelled++
    await writeAudit({ action: 'order_cancelled', targetType: 'order', targetId: r.id, performedByType: 'system', previousData: { status: 'pending' }, metadata: { reason: 'accept_timeout' } })
    await tellRestaurant(r.restaurant_id, r.id,
      `⏰ Commande #${last4(r.id)} annulée : pas acceptée à temps. Le client est remboursé.`,
      `⏰ Order #${last4(r.id)} cancelled: not accepted in time. The customer is refunded.`)
    await refundHeldOrder(r.id, 'accept_timeout', null)
  }
  if (out.checked) console.log(`[protected] accept-timeout ${JSON.stringify(out)}`)
  return out
}

// Every timed check, from the reconcile cron. Each one independent.
export async function runProtectedJobs(now = Date.now()): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  try { out.acceptTimeout = await acceptTimeoutDue(now) } catch (e) { out.acceptTimeout = { error: (e as Error).message } }
  try { out.autoRelease = await autoReleaseDue(now) } catch (e) { out.autoRelease = { error: (e as Error).message } }
  try {
    const { reconcileProPayouts } = await import('@/lib/proPayouts')
    out.payouts = await reconcileProPayouts(now)
  } catch (e) { out.payouts = { error: (e as Error).message } }
  return out
}

// ── P1d: problems ───────────────────────────────────────────────────────────
// The customer reports a problem (order page button, or WhatsApp
// "probleme"): the money stays held (funds 'disputed'), auto-release stops,
// the admins are alerted. An admin decides in Admin → Commandes →
// Problèmes: release, full refund, or partial (refund X, release the rest).

export type ProblemResult = { ok: true; id: string } | { ok: false; status: number; error: string }

export async function reportProblem(orderId: string, customerId: string | null, via: 'web' | 'whatsapp', reason: string): Promise<ProblemResult> {
  const { data: o } = await supabaseAdmin.from('orders').select('id, restaurant_id, funds_status').eq('id', orderId).maybeSingle()
  if (!o) return { ok: false, status: 404, error: 'Commande introuvable / Order not found' }
  if (o.funds_status !== 'held' && o.funds_status !== 'disputed') {
    return { ok: false, status: 409, error: 'Le paiement de cette commande n\'est plus retenu — contactez-nous / This order\'s payment is no longer held — contact us' }
  }
  const text = reason.trim().slice(0, 500) || 'Signalé sans détail / Reported without details'
  const { data: row, error } = await supabaseAdmin.from('order_problems')
    .insert({ order_id: orderId, reported_by: customerId && UUID_RE.test(customerId) ? customerId : null, via, reason: text })
    .select('id').single()
  if (error) {
    if (/order_problems_one_open|duplicate key/i.test(error.message)) return { ok: false, status: 409, error: 'Un problème est déjà signalé pour cette commande / A problem is already reported for this order' }
    return { ok: false, status: 500, error: 'Erreur — réessayez / Error — please try again' }
  }
  await supabaseAdmin.from('orders').update({ funds_status: 'disputed' }).eq('id', orderId).eq('funds_status', 'held')
  await writeAudit({ action: 'order_problem_reported', targetType: 'order', targetId: orderId, performedBy: customerId && UUID_RE.test(customerId) ? customerId : null, performedByType: 'customer', metadata: { problem_id: row.id, via, reason: text } })
  await alertAdmins(`⚠️ *Problème signalé* — commande #${last4(orderId)}\n📝 ${text}\n\nL'argent reste retenu. Décider : Admin → Commandes → Problèmes.`,
    `⚠️ *Problem reported* — order #${last4(orderId)}\n📝 ${text}\n\nThe money stays held. Decide: Admin → Orders → Problems.`, orderId)
  await tellRestaurant(o.restaurant_id as string, orderId,
    `⚠️ Le client a signalé un problème avec la commande #${last4(orderId)}. Le paiement reste retenu ; Tchop & Ndjoka vous contacte.`,
    `⚠️ The customer reported a problem with order #${last4(orderId)}. The payment stays held; Tchop & Ndjoka will contact you.`)
  return { ok: true, id: row.id as string }
}

export interface ProblemRow {
  id: string; order_id: string; code4: string; via: string; reason: string; status: string; created_at: string
  resolved_at: string | null; note: string | null; refund_id: string | null
  restaurant: string | null; customer_name: string | null; customer_phone: string | null
  total_price: number; held: number; funds_status: string | null; order_status: string
}

export async function listProblems(): Promise<ProblemRow[]> {
  const { data } = await supabaseAdmin.from('order_problems')
    .select('id, order_id, via, reason, status, created_at, resolved_at, note, refund_id, orders(customer_name, customer_phone, total_price, funds_status, status, restaurants(name))')
    .order('created_at', { ascending: false }).limit(100)
  const rows = (data ?? []) as unknown as Array<Record<string, unknown> & { orders: Record<string, unknown> & { restaurants: { name?: string } | null } | null }>
  const out: ProblemRow[] = []
  for (const r of rows) {
    const o = r.orders
    out.push({
      id: r.id as string, order_id: r.order_id as string, code4: last4(r.order_id as string), via: r.via as string,
      reason: r.reason as string, status: r.status as string, created_at: r.created_at as string,
      resolved_at: (r.resolved_at as string | null) ?? null, note: (r.note as string | null) ?? null, refund_id: (r.refund_id as string | null) ?? null,
      restaurant: o?.restaurants?.name ?? null, customer_name: (o?.customer_name as string | null) ?? null, customer_phone: (o?.customer_phone as string | null) ?? null,
      total_price: Number(o?.total_price ?? 0), held: r.status === 'open' ? await heldAmount(r.order_id as string) : 0,
      funds_status: (o?.funds_status as string | null) ?? null, order_status: (o?.status as string) ?? '',
    })
  }
  return out
}

export type Decision = { kind: 'release' } | { kind: 'refund' } | { kind: 'partial'; amount: number }

export async function resolveProblem(problemId: string, d: Decision, admin: { id: string; type: string }, note: string): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const { data: p } = await supabaseAdmin.from('order_problems').select('id, order_id, status').eq('id', problemId).maybeSingle()
  if (!p) return { ok: false, status: 404, error: 'Problème introuvable / Problem not found' }
  if (p.status !== 'open') return { ok: false, status: 409, error: 'Déjà décidé / Already decided' }
  const orderId = p.order_id as string
  const held = await heldAmount(orderId)
  const adminId = UUID_RE.test(admin.id) ? admin.id : null
  const now = new Date().toISOString()
  const close = async (status: string, refundId: string | null) => {
    const { data: won } = await supabaseAdmin.from('order_problems')
      .update({ status, resolved_by: adminId, resolved_at: now, refund_id: refundId, note: note.slice(0, 500) || null })
      .eq('id', problemId).eq('status', 'open').select('id')
    return (won ?? []).length > 0
  }

  if (d.kind === 'release') {
    if (!(await close('released', null))) return { ok: false, status: 409, error: 'Déjà décidé / Already decided' }
    const r = await releaseOrderFunds(orderId, 'admin', { id: adminId, type: admin.type })
    if (!r.ok) {
      await supabaseAdmin.from('order_problems').update({ status: 'open', resolved_at: null, resolved_by: null }).eq('id', problemId)
      return { ok: false, status: 409, error: r.error }
    }
  } else {
    const amount = d.kind === 'refund' ? held : Math.round(d.amount)
    if (!(amount > 0) || amount > held || (d.kind === 'partial' && amount === held)) {
      return { ok: false, status: 400, error: `Montant invalide (1 – ${held - 1} pour un remboursement partiel) / Invalid amount` }
    }
    const { startRefund } = await import('@/lib/refunds')
    const r = await startRefund({
      kind: 'order', targetId: orderId, amount, cancelAfter: false, adminId, adminRole: admin.type,
      reason: d.kind === 'refund' ? 'Problème avec la commande / Problem with the order' : 'Problème — remboursement partiel / Problem — partial refund',
    })
    if (!r.ok) return { ok: false, status: r.status, error: r.error }
    if (!(await close(d.kind === 'refund' ? 'refunded' : 'partly_refunded', r.refund.id))) return { ok: false, status: 409, error: 'Déjà décidé / Already decided' }
    // The refund may have completed before the problem was closed: then
    // release the rest here (onRefundSettled didn't see the problem yet).
    if (d.kind === 'partial') {
      const { data: rf } = await supabaseAdmin.from('refunds').select('status').eq('id', r.refund.id).maybeSingle()
      if (rf?.status === 'completed') await releaseOrderFunds(orderId, 'admin', { id: adminId, type: admin.type })
    }
  }
  await writeAudit({ action: 'order_problem_resolved', targetType: 'order', targetId: orderId, performedBy: adminId, performedByType: admin.type, metadata: { problem_id: problemId, decision: d, note, held } })
  return { ok: true }
}
