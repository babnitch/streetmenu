// The ONE place a PawaPay deposit outcome is written to our database.
//
// Three callers, one function:
//   - /api/payments/webhook            via 'webhook'     (PawaPay's callback)
//   - /api/payments/status/[depositId] via 'status_poll' (checkout polling)
//   - /api/payments/reconcile          via 'reconcile'   (pg_cron safety net)
//
// They race — a webhook can land while the page is polling and the cron is
// sweeping — so every transition is an ATOMIC CLAIM: a conditional update
// `… WHERE payment_status = 'pending'` that only one caller can win. Only the
// winner audits, notifies, or releases seats; everyone else gets
// 'already_settled' and does nothing. That is what stops a paid order being
// announced twice or a failed reservation's seats being released twice.
//
// Non-final PawaPay statuses (ACCEPTED / SUBMITTED / ENQUEUED …) write
// nothing — so it is always safe to call this for a deposit still in flight.
//
// BROADCAST FAN-OUT IS NOT DONE HERE. A paid broadcast is left at
// status='paid'; the webhook (and only the webhook) then triggers the send
// when it won the claim. Poll/reconcile settle it without sending and log
// loudly — stage 4 decides whether they may fan out too.

import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { writeAudit } from '@/lib/audit'
import { sendWhatsApp, getLangByPhone, pickLang } from '@/lib/whatsapp'
import { notifyPaidOrder, notifyPaidReservation } from '@/lib/payments-notify'
import type { PawaPayCorrespondent } from '@/lib/pawapay'

export type SettleVia = 'webhook' | 'status_poll' | 'reconcile'

// What PawaPay says happened. From the callback body (webhook) or from
// checkDepositStatus (poll, reconcile).
export interface DepositOutcome {
  status:         string
  amount?:        string | number
  currency?:      string
  correspondent?: PawaPayCorrespondent
  failureReason?: string | null
}

export type SettleKind = 'order' | 'reservation' | 'broadcast' | 'promotion'

export type SettleResult =
  | { kind: SettleKind; id: string; action: 'paid' | 'failed' | 'already_settled' | 'not_final' }
  | { kind: 'unknown' }

type Terminal = 'paid' | 'failed' | null

export function terminalOf(status: string): Terminal {
  if (status === 'COMPLETED') return 'paid'
  if (status === 'FAILED' || status === 'REJECTED') return 'failed'
  return null
}

// The customer-facing "payment failed" WhatsApp. Sent by the webhook and the
// reconcile job; NOT by the status poll, whose web customer already sees the
// failure on screen.
function sendsFailureNotice(via: SettleVia): boolean {
  return via === 'webhook' || via === 'reconcile'
}

export async function settleDeposit(
  depositId: string,
  outcome: DepositOutcome,
  via: SettleVia,
): Promise<SettleResult> {
  const terminal = terminalOf(outcome.status)

  const { data: order } = await supabaseAdmin
    .from('orders').select('id, payment_status').eq('payment_id', depositId).maybeSingle()
  if (order) return settleOrder(order.id, depositId, outcome, terminal, via)

  const { data: reservation } = await supabaseAdmin
    .from('event_reservations').select('id').eq('payment_id', depositId).maybeSingle()
  if (reservation) return settleReservation(reservation.id, depositId, outcome, terminal, via)

  const { data: broadcast } = await supabaseAdmin
    .from('broadcasts').select('id, sender_id').eq('payment_id', depositId).maybeSingle()
  if (broadcast) return settleBroadcast(broadcast, depositId, outcome, terminal, via)

  const { data: promo } = await supabaseAdmin
    .from('promotions').select('id, promoter_id').eq('payment_id', depositId).maybeSingle()
  if (promo) return settlePromotion(promo, depositId, outcome, terminal, via)

  return { kind: 'unknown' }
}

// The claim. Returns the claimed row (with the columns asked for) or null
// when someone else already settled it.
async function claim<T>(
  table: string,
  id: string,
  patch: Record<string, unknown>,
  select: string,
): Promise<T | null> {
  const { data, error } = await supabaseAdmin
    .from(table)
    .update(patch)
    .eq('id', id)
    .eq('payment_status', 'pending')
    .select(select)
    .maybeSingle()
  if (error) throw new Error(`[settle] claim ${table}=${id} failed: ${error.message}`)
  return (data as T | null) ?? null
}

function logSettled(kind: SettleKind, id: string, action: string, depositId: string, via: SettleVia) {
  console.log(`[payment] settle via=${via} ${kind}=${id} deposit=${depositId} → ${action}`)
}

// ── Orders ───────────────────────────────────────────────────────────────────

async function settleOrder(
  id: string, depositId: string, outcome: DepositOutcome, terminal: Terminal, via: SettleVia,
): Promise<SettleResult> {
  if (!terminal) return { kind: 'order', id, action: 'not_final' }

  if (terminal === 'paid') {
    const won = await claim<{ id: string }>('orders', id,
      { payment_status: 'paid', payment_at: new Date().toISOString() }, 'id')
    if (!won) return { kind: 'order', id, action: 'already_settled' }
    logSettled('order', id, 'paid', depositId, via)
    await writeAudit({
      action:     'payment_completed',
      targetType: 'order',
      targetId:   id,
      metadata:   { deposit_id: depositId, via, amount: outcome.amount, currency: outcome.currency, correspondent: outcome.correspondent },
    })
    await notifyPaidOrder(id, outcome.correspondent)
    return { kind: 'order', id, action: 'paid' }
  }

  const won = await claim<{ id: string; customer_phone: string | null }>('orders', id,
    { payment_status: 'failed' }, 'id, customer_phone')
  if (!won) return { kind: 'order', id, action: 'already_settled' }
  logSettled('order', id, 'failed', depositId, via)
  await writeAudit({
    action:     'payment_failed',
    targetType: 'order',
    targetId:   id,
    metadata:   { deposit_id: depositId, via, reason: outcome.failureReason ?? null, amount: outcome.amount, currency: outcome.currency },
  })
  if (sendsFailureNotice(via) && won.customer_phone) {
    const lang = await getLangByPhone(won.customer_phone)
    await sendWhatsApp(won.customer_phone, [
      pickLang(`❌ *Paiement échoué*`, `❌ *Payment failed*`, lang),
      ``,
      pickLang(
        `Votre paiement n'a pas abouti. Envoyez "payer" pour réessayer ou contactez le restaurant.`,
        `Your payment didn't go through. Send "pay" to retry or contact the restaurant.`,
        lang,
      ),
    ].join('\n'), { context: 'payment_confirmation', relatedId: id }).catch(() => null)
  }
  return { kind: 'order', id, action: 'failed' }
}

// ── Event reservations ───────────────────────────────────────────────────────

interface ClaimedReservation {
  id: string; event_id: string; quantity: number | null; tier_id: string | null; customer_phone: string | null
}

async function settleReservation(
  id: string, depositId: string, outcome: DepositOutcome, terminal: Terminal, via: SettleVia,
): Promise<SettleResult> {
  if (!terminal) return { kind: 'reservation', id, action: 'not_final' }
  const now = new Date().toISOString()

  if (terminal === 'paid') {
    const won = await claim<ClaimedReservation>('event_reservations', id,
      { payment_status: 'paid', updated_at: now }, 'id, event_id, quantity, tier_id, customer_phone')
    if (!won) return { kind: 'reservation', id, action: 'already_settled' }
    logSettled('reservation', id, 'paid', depositId, via)
    await writeAudit({
      action:     'event_payment_completed',
      targetType: 'event_reservation',
      targetId:   id,
      metadata:   {
        deposit_id: depositId, via, amount: outcome.amount, currency: outcome.currency,
        correspondent: outcome.correspondent, event_id: won.event_id,
      },
    })
    await notifyPaidReservation(id, outcome.correspondent)
    return { kind: 'reservation', id, action: 'paid' }
  }

  const won = await claim<ClaimedReservation>('event_reservations', id,
    { payment_status: 'failed', updated_at: now }, 'id, event_id, quantity, tier_id, customer_phone')
  if (!won) return { kind: 'reservation', id, action: 'already_settled' }
  logSettled('reservation', id, 'failed', depositId, via)

  // Release the seats held while the MoMo prompt was open — the event total
  // AND the tier's sold_count, so the public picker shows them available
  // again. Only the claim winner gets here, so this runs once per deposit.
  // (Read-then-write against concurrent bookings is the same as every other
  // seat counter in the app; there is no atomic counter RPC yet.)
  await releaseSeats(won, now)

  await writeAudit({
    action:     'event_payment_failed',
    targetType: 'event_reservation',
    targetId:   id,
    metadata:   {
      deposit_id: depositId, via, reason: outcome.failureReason ?? null,
      amount: outcome.amount, currency: outcome.currency, event_id: won.event_id,
    },
  })
  if (sendsFailureNotice(via) && won.customer_phone) {
    const lang = await getLangByPhone(won.customer_phone)
    await sendWhatsApp(won.customer_phone, [
      pickLang(`❌ *Paiement échoué*`, `❌ *Payment failed*`, lang),
      ``,
      pickLang(
        `Votre paiement pour la réservation n'a pas abouti. Réessayez ou contactez l'organisateur.`,
        `Your reservation payment didn't go through. Retry or contact the organizer.`,
        lang,
      ),
    ].join('\n'), { context: 'payment_confirmation', relatedId: id }).catch(() => null)
  }
  return { kind: 'reservation', id, action: 'failed' }
}

async function releaseSeats(r: ClaimedReservation, now: string): Promise<void> {
  const qty = Number(r.quantity ?? 0)
  if (qty <= 0) return

  const { data: ev } = await supabaseAdmin
    .from('events').select('tickets_sold').eq('id', r.event_id).maybeSingle()
  await supabaseAdmin
    .from('events')
    .update({ tickets_sold: Math.max(0, Number(ev?.tickets_sold ?? 0) - qty) })
    .eq('id', r.event_id)

  if (r.tier_id) {
    const { data: tier } = await supabaseAdmin
      .from('event_ticket_tiers').select('sold_count').eq('id', r.tier_id).maybeSingle()
    await supabaseAdmin
      .from('event_ticket_tiers')
      .update({ sold_count: Math.max(0, Number(tier?.sold_count ?? 0) - qty), updated_at: now })
      .eq('id', r.tier_id)
  }
}

// ── Broadcasts ───────────────────────────────────────────────────────────────

async function settleBroadcast(
  b: { id: string; sender_id: string },
  depositId: string, outcome: DepositOutcome, terminal: Terminal, via: SettleVia,
): Promise<SettleResult> {
  if (!terminal) return { kind: 'broadcast', id: b.id, action: 'not_final' }

  if (terminal === 'paid') {
    const won = await claim<{ id: string }>('broadcasts', b.id, { payment_status: 'paid', status: 'paid' }, 'id')
    if (!won) return { kind: 'broadcast', id: b.id, action: 'already_settled' }
    logSettled('broadcast', b.id, 'paid', depositId, via)
    await writeAudit({
      action:          'broadcast_paid',
      targetType:      'customer',
      targetId:        b.sender_id,
      performedBy:     b.sender_id,
      performedByType: 'system',
      metadata: {
        broadcast_id: b.id, deposit_id: depositId, via,
        amount: outcome.amount, currency: outcome.currency, correspondent: outcome.correspondent,
        // Queryable marker for the paid-but-unsent gap.
        fan_out: via === 'webhook' ? 'triggered_by_webhook' : `not_triggered_by_${via}`,
      },
    })
    if (via !== 'webhook') {
      // Loud on purpose: the sender has paid and NOTHING has gone out yet.
      console.error(
        `[payments/settle] broadcast=${b.id} settled PAID via ${via}, but the fan-out is ` +
        `webhook-only — it is stuck at status=paid and nothing has been sent. Recover with: ` +
        `POST /api/broadcasts/${b.id}/send (Authorization: Bearer <INTERNAL_API_SECRET>).`,
      )
    }
    return { kind: 'broadcast', id: b.id, action: 'paid' }
  }

  const won = await claim<{ id: string }>('broadcasts', b.id, { payment_status: 'failed', status: 'failed' }, 'id')
  if (!won) return { kind: 'broadcast', id: b.id, action: 'already_settled' }
  logSettled('broadcast', b.id, 'failed', depositId, via)
  await writeAudit({
    action:          'broadcast_payment_failed',
    targetType:      'customer',
    targetId:        b.sender_id,
    performedBy:     b.sender_id,
    performedByType: 'system',
    metadata: { broadcast_id: b.id, deposit_id: depositId, via, reason: outcome.failureReason ?? null },
  })
  return { kind: 'broadcast', id: b.id, action: 'failed' }
}

// ── Promotions ───────────────────────────────────────────────────────────────
// No fan-out: a paid promotion lands in pending_review for an admin to vet.

async function settlePromotion(
  p: { id: string; promoter_id: string },
  depositId: string, outcome: DepositOutcome, terminal: Terminal, via: SettleVia,
): Promise<SettleResult> {
  if (!terminal) return { kind: 'promotion', id: p.id, action: 'not_final' }
  const patch = terminal === 'paid'
    ? { payment_status: 'paid',   status: 'pending_review' }
    : { payment_status: 'failed', status: 'rejected' }
  const won = await claim<{ id: string }>('promotions', p.id, { ...patch, updated_at: new Date().toISOString() }, 'id')
  if (!won) return { kind: 'promotion', id: p.id, action: 'already_settled' }
  logSettled('promotion', p.id, terminal, depositId, via)
  await writeAudit({
    action:          terminal === 'paid' ? 'promotion_paid' : 'promotion_payment_failed',
    targetType:      'promotion',
    targetId:        p.id,
    performedBy:     p.promoter_id,
    performedByType: 'system',
    metadata: {
      deposit_id: depositId, via, amount: outcome.amount, currency: outcome.currency,
      correspondent: outcome.correspondent,
      reason: terminal === 'paid' ? undefined : (outcome.failureReason ?? null),
    },
  })
  return { kind: 'promotion', id: p.id, action: terminal }
}
