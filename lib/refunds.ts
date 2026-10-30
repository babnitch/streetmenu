// R2 — refunds of a paid order or a paid ticket, through PawaPay.
//
// One refund = one row in `refunds`, whose id IS the PawaPay refundId and is
// written BEFORE PawaPay is called (start_refund, supabase-refunds-r.sql).
// start_refund checks, in one transaction: the payment is paid, no other
// refund of it is in progress, and the total refunded stays ≤ the amount
// paid.
//
// The outcome is written by settle_refund — pending → completed | failed,
// ONCE. Three callers race, exactly like deposits (lib/payments-settle.ts):
//   - /api/payments/refund-webhook   via 'webhook'    (PawaPay's callback)
//   - /api/admin/refunds/[id]        via 'status_poll' (the admin's screen)
//   - /api/payments/reconcile        via 'reconcile'  (pg_cron safety net)
// Only the winner audits, messages the customer (one WhatsApp), cancels a
// fully refunded order, or cancels the reservation (releasing its seats).

import { randomUUID } from 'crypto'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { writeAudit } from '@/lib/audit'
import { sendWhatsApp, getLangByPhone, pickLang } from '@/lib/whatsapp'
import { createRefund, checkRefundStatus, isPawaPayTimeout, type PawaPayStatus } from '@/lib/pawapay'
import { closeReservation } from '@/lib/eventSeats'
import { formatFCFA } from '@/lib/money'

export type RefundKind = 'order' | 'reservation'
export type RefundVia = 'initiate' | 'webhook' | 'status_poll' | 'reconcile'

export interface RefundRow {
  id: string; kind: RefundKind; order_id: string | null; reservation_id: string | null
  deposit_id: string; amount: number; currency: string; reason: string; cancel_after: boolean
  status: 'pending' | 'completed' | 'failed'; pawapay_status: string | null; failure_reason: string | null
  requested_by: string | null; created_at: string; updated_at: string; completed_at: string | null
}

const START_ERRORS: Record<string, { status: number; error: string }> = {
  not_found:          { status: 404, error: 'Introuvable / Not found' },
  not_paid:           { status: 409, error: 'Ce paiement n\'est pas payé par Mobile Money / This was not paid by Mobile Money' },
  no_deposit:         { status: 409, error: 'Aucun paiement PawaPay lié / No PawaPay payment linked' },
  refund_in_progress: { status: 409, error: 'Un remboursement est déjà en cours pour ce paiement / A refund is already in progress for this payment' },
  over_amount:        { status: 409, error: 'Montant supérieur à ce qui reste à rembourser / Amount above what is left to refund' },
  bad_amount:         { status: 400, error: 'Montant invalide / Invalid amount' },
}

export type StartRefundResult =
  | { ok: true; refund: RefundRow; pawapay: PawaPayStatus | 'TIMEOUT' }
  | { ok: false; status: number; error: string; reason?: string; refund?: RefundRow }

export async function startRefund(p: {
  kind: RefundKind; targetId: string; amount: number; reason: string; cancelAfter: boolean; adminId: string | null; adminRole: string
}): Promise<StartRefundResult> {
  const id = randomUUID()
  const { data, error } = await supabaseAdmin.rpc('start_refund', {
    p_id: id, p_kind: p.kind, p_target: p.targetId, p_amount: Math.round(p.amount),
    p_reason: p.reason, p_cancel: p.cancelAfter, p_admin: p.adminId,
  })
  if (error) {
    const known = START_ERRORS[error.message]
    if (known) return { ok: false, ...known, reason: error.message }
    if (/refunds_one_pending_per_deposit|duplicate key/i.test(error.message)) return { ok: false, ...START_ERRORS.refund_in_progress, reason: 'refund_in_progress' }
    console.error('[refund] start failed:', error.message)
    return { ok: false, status: 500, error: 'Erreur — réessayez / Error — please try again' }
  }
  const refund = data as RefundRow
  // Protected payment: while a refund runs, the held money can't be released.
  if (p.kind === 'order') {
    const { fundsRefunding } = await import('@/lib/protectedPayments')
    await fundsRefunding(p.targetId)
  }
  await writeAudit({
    action: 'refund_requested', targetType: p.kind === 'order' ? 'order' : 'event_reservation', targetId: p.targetId,
    performedBy: p.adminId, performedByType: p.adminRole,
    metadata: { refund_id: refund.id, deposit_id: refund.deposit_id, amount: refund.amount, reason: refund.reason, cancel_after: refund.cancel_after },
  })

  try {
    const r = await createRefund({ refundId: refund.id, depositId: refund.deposit_id, amount: refund.amount })
    if (r.status === 'REJECTED' || r.status === 'FAILED') {
      await settleRefund(refund.id, { status: r.status, failureReason: r.rejection }, 'initiate')
      const { data: after } = await supabaseAdmin.from('refunds').select('*').eq('id', refund.id).single()
      return { ok: false, status: 502, error: `PawaPay a refusé le remboursement / PawaPay refused the refund: ${r.rejection ?? r.status}`, refund: after as RefundRow }
    }
    await supabaseAdmin.from('refunds').update({ pawapay_status: r.status, updated_at: new Date().toISOString() }).eq('id', refund.id).eq('status', 'pending')
    return { ok: true, refund, pawapay: r.status }
  } catch (e) {
    // Timeout / network: PawaPay may or may not have it. It stays pending;
    // the status check and the reconcile job find out (never re-sent).
    console.error('[refund] PawaPay call failed for %s: %s', refund.id, (e as Error).message)
    return { ok: true, refund, pawapay: isPawaPayTimeout(e) ? 'TIMEOUT' : 'ACCEPTED' }
  }
}

export type SettleRefundResult = { id: string; action: 'completed' | 'failed' | 'not_final' | 'already_settled' | 'unknown' }

export function refundTerminal(status: string): 'completed' | 'failed' | null {
  if (status === 'COMPLETED') return 'completed'
  if (status === 'FAILED' || status === 'REJECTED') return 'failed'
  return null
}

export async function settleRefund(
  refundId: string, outcome: { status: string; failureReason?: string | null }, via: RefundVia,
): Promise<SettleRefundResult> {
  const terminal = refundTerminal(outcome.status)
  if (!terminal) {
    await supabaseAdmin.from('refunds').update({ pawapay_status: outcome.status, updated_at: new Date().toISOString() })
      .eq('id', refundId).eq('status', 'pending')
    return { id: refundId, action: 'not_final' }
  }
  const { data, error } = await supabaseAdmin.rpc('settle_refund', {
    p_id: refundId, p_status: terminal, p_pawapay_status: outcome.status, p_failure: outcome.failureReason ?? null,
  })
  if (error) throw new Error(`[refund] settle ${refundId} failed: ${error.message}`)
  const won = data as RefundRow | null
  if (!won || !won.id) {
    const { data: exists } = await supabaseAdmin.from('refunds').select('id').eq('id', refundId).maybeSingle()
    return { id: refundId, action: exists ? 'already_settled' : 'unknown' }
  }
  console.log(`[refund] settle via=${via} refund=${refundId} ${won.kind}=${won.order_id ?? won.reservation_id} → ${terminal}`)
  const targetId = (won.order_id ?? won.reservation_id) as string
  await writeAudit({
    action: terminal === 'completed' ? 'refund_completed' : 'refund_failed',
    targetType: won.kind === 'order' ? 'order' : 'event_reservation', targetId,
    performedByType: 'system',
    metadata: { refund_id: won.id, deposit_id: won.deposit_id, amount: won.amount, via, pawapay_status: outcome.status, failure: outcome.failureReason ?? null },
  })
  // Protected payment: the ledger follows the refund (held → customer), or a
  // failed refund leaves the money held for an admin to decide.
  if (won.kind === 'order' && won.order_id) {
    const { onRefundSettled } = await import('@/lib/protectedPayments')
    await onRefundSettled(won.order_id, won.id, won.amount, terminal)
  }
  if (terminal === 'completed') await afterCompleted(won)
  return { id: refundId, action: terminal }
}

// The winner's side effects, once per refund.
async function afterCompleted(r: RefundRow): Promise<void> {
  let phone: string | null = null
  let what = ''
  if (r.kind === 'order' && r.order_id) {
    const { data: o } = await supabaseAdmin.from('orders').select('id, customer_phone, refund_status, status').eq('id', r.order_id).single()
    phone = (o?.customer_phone as string | null) ?? null
    const id4 = r.order_id.replace(/-/g, '').slice(-4).toUpperCase()
    what = `#${id4}`
    // A full refund cancels the order.
    if (o?.refund_status === 'refunded' && o.status !== 'cancelled') {
      await supabaseAdmin.from('orders').update({ status: 'cancelled' }).eq('id', r.order_id)
      await writeAudit({ action: 'order_cancelled_by_refund', targetType: 'order', targetId: r.order_id, performedByType: 'system', previousData: { status: o.status }, metadata: { refund_id: r.id } })
    }
  } else if (r.reservation_id) {
    const { data: res } = await supabaseAdmin.from('event_reservations')
      .select('id, customer_phone, reservation_code, events(title)').eq('id', r.reservation_id).single()
    phone = (res?.customer_phone as string | null) ?? null
    const title = (res?.events as unknown as { title?: string } | null)?.title ?? ''
    what = `${res?.reservation_code ? `#${res.reservation_code} ` : ''}${title ? `« ${title} »` : ''}`.trim()
    // Cancelling releases the seats, as a normal cancellation does.
    if (r.cancel_after) {
      const closed = await closeReservation(r.reservation_id, 'cancelled').catch(e => { console.error('[refund] cancel reservation failed:', (e as Error).message); return null })
      if (closed) {
        await writeAudit({ action: 'event_reservation_cancelled', targetType: 'event_reservation', targetId: r.reservation_id, performedByType: 'system', metadata: { refund_id: r.id, cancelled_by: 'refund' } })
      }
    }
  }
  if (!phone) return
  const lang = await getLangByPhone(phone)
  const amount = formatFCFA(r.amount)
  const text = r.kind === 'order'
    ? pickLang(
        `💸 *Remboursement effectué*\n\n${amount} ont été renvoyés sur votre Mobile Money pour la commande ${what}.\n📝 ${r.reason}`,
        `💸 *Refund sent*\n\n${amount} has been sent back to your Mobile Money for order ${what}.\n📝 ${r.reason}`, lang)
    : pickLang(
        `💸 *Remboursement effectué*\n\n${amount} ont été renvoyés sur votre Mobile Money pour votre réservation ${what}.${r.cancel_after ? '\nLa réservation est annulée.' : ''}\n📝 ${r.reason}`,
        `💸 *Refund sent*\n\n${amount} has been sent back to your Mobile Money for your booking ${what}.${r.cancel_after ? '\nThe booking is cancelled.' : ''}\n📝 ${r.reason}`, lang)
  await sendWhatsApp(phone, text, { context: 'payment_confirmation', relatedId: (r.order_id ?? r.reservation_id) as string }).catch(() => null)
}

// ── Reconcile (pg_cron, every ~10 min, same route as deposits) ──────────────
export const REFUND_RECONCILE_MIN_AGE_MS = 2 * 60 * 1000
export const REFUND_RECONCILE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
// PawaPay never saw it (lost request): after this long it is marked failed,
// so the admin can try again.
export const REFUND_NOT_FOUND_FAIL_MS = 30 * 60 * 1000

export async function reconcileRefunds(now = Date.now()): Promise<{ checked: number; completed: number; failed: number; pending: number; errors: number }> {
  const from = new Date(now - REFUND_RECONCILE_MAX_AGE_MS).toISOString()
  const to = new Date(now - REFUND_RECONCILE_MIN_AGE_MS).toISOString()
  const { data } = await supabaseAdmin.from('refunds').select('id, created_at')
    .eq('status', 'pending').gte('created_at', from).lte('created_at', to).order('created_at').limit(25)
  const out = { checked: 0, completed: 0, failed: 0, pending: 0, errors: 0 }
  for (const row of (data ?? []) as Array<{ id: string; created_at: string }>) {
    out.checked++
    try {
      const st = await checkRefundStatus(row.id)
      const outcome = st.notFound && now - new Date(row.created_at).getTime() > REFUND_NOT_FOUND_FAIL_MS
        ? { status: 'FAILED', failureReason: 'Inconnu chez PawaPay / Not found at PawaPay' }
        : { status: st.status, failureReason: st.failureReason }
      const r = await settleRefund(row.id, outcome, 'reconcile')
      if (r.action === 'completed') out.completed++
      else if (r.action === 'failed') out.failed++
      else out.pending++
    } catch (e) {
      out.errors++
      console.error('[refund-reconcile] %s: %s', row.id, (e as Error).message)
    }
  }
  if (out.checked) console.log(`[refund-reconcile] ${JSON.stringify(out)}`)
  return out
}
