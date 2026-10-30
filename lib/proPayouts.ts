// Protected payments P2 (minimal): balances and daily payouts to pros.
// Server-only.
//
// Balance = sum of money_ledger lines (append-only): held → available →
// in transit → paid out. Only money of the current mode counts: real money
// in production, sandbox (is_test) money while PawaPay runs in sandbox —
// so a real payout never sees test money and the reverse.
//
// Admin → Commandes → "À payer": "Payer" sends a pro's whole available
// balance to their payout number. One payout per pro per day (database
// unique index). pro_payouts row first (its id IS the PawaPay payoutId),
// then payout_post('started') moves available → in transit, then PawaPay.
// The outcome (callback, or the reconcile job's status check) moves it to
// paid out, or back to available when it failed — once (payout_post).
//
// Payout number: restaurants.payout_phone, else the WhatsApp number. A
// change asked by the owner waits in payout_phone_pending until an admin
// confirms it (a hijacked account can't redirect the money).

import { randomUUID } from 'crypto'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { writeAudit } from '@/lib/audit'
import { createPayout, checkPayoutStatus, detectMNO } from '@/lib/pawapay'
import { isSandboxMoney } from '@/lib/protectedPayments'
import { sendWhatsApp, getLangByPhone, pickLang } from '@/lib/whatsapp'
import { formatFCFA } from '@/lib/money'
import { testGuardPrefix } from '@/lib/testGuard'
import { normalizePhone } from '@/lib/phone'

export interface Balances { held: number; available: number; in_transit: number; paid_out: number }
const EMPTY: Balances = { held: 0, available: 0, in_transit: 0, paid_out: 0 }

// Today in Cameroon (the "one payout per day" day).
export function payoutDay(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Douala', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

export async function restaurantBalances(restaurantId: string): Promise<Balances> {
  const { data } = await supabaseAdmin.from('money_ledger').select('bucket, delta')
    .eq('party_type', 'restaurant').eq('party_id', restaurantId).eq('is_test', isSandboxMoney())
  const out = { ...EMPTY }
  for (const r of (data ?? []) as Array<{ bucket: keyof Balances; delta: number }>) {
    if (r.bucket in out) out[r.bucket] += Number(r.delta)
  }
  return out
}

export interface ToPay {
  restaurant_id: string; name: string; city: string; available: number; in_transit: number
  phone: string | null; phone_pending: string | null; paid_today: boolean
}

// Test-city restaurants (automated tests) only show on the local test server.
const isFixtureCity = (city: string | null | undefined) => (city ?? '').startsWith('__t_')

export async function toPayList(): Promise<ToPay[]> {
  const { data: lines } = await supabaseAdmin.from('money_ledger').select('party_id, bucket, delta')
    .eq('party_type', 'restaurant').in('bucket', ['available', 'in_transit']).eq('is_test', isSandboxMoney())
  const sums = new Map<string, { available: number; in_transit: number }>()
  for (const l of (lines ?? []) as Array<{ party_id: string; bucket: 'available' | 'in_transit'; delta: number }>) {
    const s = sums.get(l.party_id) ?? { available: 0, in_transit: 0 }
    s[l.bucket] += Number(l.delta)
    sums.set(l.party_id, s)
  }
  const ids = Array.from(sums.entries()).filter(([, s]) => s.available > 0 || s.in_transit > 0).map(([id]) => id)
  // Payout number changes waiting for an admin, even with nothing to pay.
  const { data: pendingPhones } = await supabaseAdmin.from('restaurants').select('id').not('payout_phone_pending', 'is', null)
  const all = Array.from(new Set([...ids, ...((pendingPhones ?? []) as Array<{ id: string }>).map(r => r.id)]))
  if (!all.length) return []
  const { data: rests } = await supabaseAdmin.from('restaurants').select('id, name, city, whatsapp, payout_phone, payout_phone_pending').in('id', all)
  const { data: today } = await supabaseAdmin.from('pro_payouts').select('party_id')
    .eq('party_type', 'restaurant').eq('day', payoutDay()).neq('status', 'failed').in('party_id', all)
  const paid = new Set(((today ?? []) as Array<{ party_id: string }>).map(r => r.party_id))
  const showFixtures = !!testGuardPrefix()
  return ((rests ?? []) as Array<Record<string, string | null>>)
    .filter(r => showFixtures || !isFixtureCity(r.city))
    .map(r => {
      const s = sums.get(r.id as string) ?? { available: 0, in_transit: 0 }
      return {
        restaurant_id: r.id as string, name: (r.name as string) ?? '—', city: (r.city as string) ?? '',
        available: s.available, in_transit: s.in_transit,
        phone: r.payout_phone ?? r.whatsapp ?? null, phone_pending: r.payout_phone_pending ?? null,
        paid_today: paid.has(r.id as string),
      }
    })
    .sort((a, b) => b.available - a.available)
}

export type PayResult = { ok: true; payoutId: string; amount: number; status: string } | { ok: false; status: number; error: string }

export async function payRestaurant(restaurantId: string, admin: { id: string; type: string }): Promise<PayResult> {
  const { data: r } = await supabaseAdmin.from('restaurants').select('id, name, whatsapp, payout_phone').eq('id', restaurantId).maybeSingle()
  if (!r) return { ok: false, status: 404, error: 'Restaurant introuvable / Restaurant not found' }
  const phone = (r.payout_phone as string | null) ?? (r.whatsapp as string | null)
  if (!phone) return { ok: false, status: 400, error: 'Aucun numéro de paiement / No payout number' }
  const mno = detectMNO(phone)
  if (!mno) return { ok: false, status: 400, error: 'Numéro de paiement non supporté / Unsupported payout number' }
  const { available } = await restaurantBalances(restaurantId)
  if (!(available > 0)) return { ok: false, status: 409, error: 'Rien à payer / Nothing to pay' }

  const id = randomUUID()
  const sandbox = isSandboxMoney()
  const { error: insErr } = await supabaseAdmin.from('pro_payouts').insert({
    id, party_type: 'restaurant', party_id: restaurantId, amount: available, phone, day: payoutDay(),
    is_test: sandbox, requested_by: /^[0-9a-f-]{36}$/i.test(admin.id) ? admin.id : null,
  })
  if (insErr) {
    if (/pro_payouts_one_per_day|duplicate key/i.test(insErr.message)) return { ok: false, status: 409, error: 'Déjà payé aujourd\'hui / Already paid today' }
    return { ok: false, status: 500, error: insErr.message }
  }
  // The row's is_test can only be stricter than the mode (trigger: test pro
  // or +999). A row that turned test in production must not pay real money.
  const { data: row } = await supabaseAdmin.from('pro_payouts').select('is_test').eq('id', id).single()
  if (row?.is_test !== sandbox) {
    await supabaseAdmin.from('pro_payouts').update({ status: 'failed', failure_reason: 'test pro' }).eq('id', id)
    return { ok: false, status: 409, error: 'Pro de test : pas de paiement réel / Test pro: no real payout' }
  }
  const { error: startErr } = await supabaseAdmin.rpc('payout_post', { p_payout: id, p_phase: 'started' })
  if (startErr) {
    await supabaseAdmin.from('pro_payouts').update({ status: 'failed', failure_reason: startErr.message }).eq('id', id)
    return { ok: false, status: 409, error: /payout_over_available/.test(startErr.message) ? 'Solde insuffisant / Balance too low' : startErr.message }
  }
  await writeAudit({
    action: 'pro_payout_started', targetType: 'restaurant', targetId: restaurantId, performedBy: admin.id, performedByType: admin.type,
    metadata: { payout_id: id, amount: available, phone, sandbox },
  })
  try {
    const res = await createPayout({ payoutId: id, amount: available, currency: mno.currency, phoneNumber: phone, description: `Tchop ${String(r.name)}`.slice(0, 22) })
    await supabaseAdmin.from('pro_payouts').update({ pawapay_status: res.status }).eq('id', id).eq('status', 'pending')
    return { ok: true, payoutId: id, amount: available, status: res.status }
  } catch (e) {
    const msg = (e as Error).message
    // Refused at once → back to available. A timeout stays pending: the
    // reconcile job asks PawaPay (never paid twice: same payoutId).
    if (/refus|rejected/i.test(msg)) {
      await settleProPayout(id, 'REJECTED', msg)
      return { ok: false, status: 502, error: `PawaPay a refusé le paiement / PawaPay refused the payout: ${msg}` }
    }
    console.error('[payouts] PawaPay call failed for %s: %s', id, msg)
    return { ok: true, payoutId: id, amount: available, status: 'PENDING' }
  }
}

// The outcome, once (payout_post claims the pending row). From the PawaPay
// callback and the reconcile job.
export async function settleProPayout(id: string, status: string, failure: string | null): Promise<'completed' | 'failed' | 'not_final' | 'already_settled' | 'unknown'> {
  const terminal = status === 'COMPLETED' ? 'completed' : status === 'FAILED' || status === 'REJECTED' ? 'failed' : null
  const { data: p } = await supabaseAdmin.from('pro_payouts').select('id, party_id, amount, phone, status').eq('id', id).maybeSingle()
  if (!p) return 'unknown'
  if (!terminal) {
    await supabaseAdmin.from('pro_payouts').update({ pawapay_status: status }).eq('id', id).eq('status', 'pending')
    return 'not_final'
  }
  const { data: won, error } = await supabaseAdmin.rpc('payout_post', { p_payout: id, p_phase: terminal })
  if (error) throw new Error(`[payouts] settle ${id}: ${error.message}`)
  if (won !== true) return 'already_settled'
  await supabaseAdmin.from('pro_payouts').update({ pawapay_status: status, failure_reason: failure }).eq('id', id)
  await writeAudit({
    action: terminal === 'completed' ? 'pro_payout_completed' : 'pro_payout_failed', targetType: 'restaurant', targetId: p.party_id as string,
    performedByType: 'system', metadata: { payout_id: id, amount: p.amount, status, failure },
  })
  if (terminal === 'completed') {
    const { vendorRecipients } = await import('@/lib/whatsapp/ordering')
    for (const to of await vendorRecipients(p.party_id as string)) {
      await sendWhatsApp(to, pickLang(
        `💸 ${formatFCFA(Number(p.amount))} envoyés sur votre Mobile Money (${p.phone}). Merci !`,
        `💸 ${formatFCFA(Number(p.amount))} sent to your Mobile Money (${p.phone}). Thank you!`, await getLangByPhone(to)),
        { context: 'payment_confirmation', relatedId: id }).catch(() => null)
    }
  }
  return terminal
}

// Reconcile: payouts still pending after 2 minutes → ask PawaPay.
export async function reconcileProPayouts(now = Date.now()): Promise<{ checked: number; settled: number }> {
  const { data } = await supabaseAdmin.from('pro_payouts').select('id, created_at')
    .eq('status', 'pending').lte('created_at', new Date(now - 2 * 60_000).toISOString())
    .gte('created_at', new Date(now - 7 * 86_400_000).toISOString()).order('created_at').limit(25)
  const out = { checked: 0, settled: 0 }
  for (const r of (data ?? []) as Array<{ id: string; created_at: string }>) {
    out.checked++
    try {
      const st = await checkPayoutStatus(r.id)
      if (st.notFound) {
        // PawaPay never got it: after 30 min, back to available.
        if (now - new Date(r.created_at).getTime() > 30 * 60_000) {
          if ((await settleProPayout(r.id, 'FAILED', 'Inconnu chez PawaPay / Not found at PawaPay')) === 'failed') out.settled++
        }
        continue
      }
      const s = await settleProPayout(r.id, st.status, st.failureReason)
      if (s === 'completed' || s === 'failed') out.settled++
    } catch (e) {
      console.error('[payouts] reconcile %s: %s', r.id, (e as Error).message)
    }
  }
  return out
}

// ── Payout number ───────────────────────────────────────────────────────────
export async function requestPayoutPhone(restaurantId: string, rawPhone: string, actor: { id: string; type: string }): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const phone = normalizePhone(rawPhone)
  if (!phone || !detectMNO(phone)) return { ok: false, status: 400, error: 'Numéro Mobile Money non supporté / Unsupported Mobile Money number' }
  const { error } = await supabaseAdmin.from('restaurants').update({ payout_phone_pending: phone }).eq('id', restaurantId)
  if (error) return { ok: false, status: 500, error: error.message }
  await writeAudit({ action: 'payout_phone_requested', targetType: 'restaurant', targetId: restaurantId, performedBy: actor.id, performedByType: actor.type, metadata: { phone } })
  return { ok: true }
}

export async function decidePayoutPhone(restaurantId: string, approve: boolean, admin: { id: string; type: string }): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const { data: r } = await supabaseAdmin.from('restaurants').select('payout_phone, payout_phone_pending').eq('id', restaurantId).maybeSingle()
  if (!r?.payout_phone_pending) return { ok: false, status: 409, error: 'Aucun changement en attente / No change waiting' }
  const { data: won } = await supabaseAdmin.from('restaurants')
    .update(approve ? { payout_phone: r.payout_phone_pending, payout_phone_pending: null } : { payout_phone_pending: null })
    .eq('id', restaurantId).eq('payout_phone_pending', r.payout_phone_pending).select('id')
  if (!(won ?? []).length) return { ok: false, status: 409, error: 'Déjà décidé / Already decided' }
  await writeAudit({
    action: approve ? 'payout_phone_confirmed' : 'payout_phone_declined', targetType: 'restaurant', targetId: restaurantId,
    performedBy: admin.id, performedByType: admin.type, previousData: { payout_phone: r.payout_phone }, metadata: { requested: r.payout_phone_pending },
  })
  return { ok: true }
}
