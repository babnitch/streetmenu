import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { checkDepositStatus } from '@/lib/pawapay'
import { notifyPaidOrder, notifyPaidReservation } from '@/lib/payments-notify'
import { writeAudit } from '@/lib/audit'

export const dynamic = 'force-dynamic'

type DepositInfo = Awaited<ReturnType<typeof checkDepositStatus>>

// Settle a paid broadcast from PawaPay's answer. Mirrors the transitions in
// /api/payments/webhook exactly, so the two writers can never disagree about
// what "paid" means.
//
// DELIBERATELY DOES NOT FAN OUT. The claim below is atomic, but the webhook's
// own guard is still a read-then-write, so a webhook and a poll arriving
// together could both conclude they won. For an order that costs one duplicate
// WhatsApp; for a broadcast it would send the whole city the same message
// twice, and nothing can recall it. Marking it paid leaves the row at
// status='paid' — exactly the state /api/broadcasts/<id>/send requires — so
// the send is one authenticated POST away. See the report/commit note: until
// the webhook claims atomically too, poll-side fan-out is not safe.
async function reconcileBroadcast(
  broadcast: { id: string; sender_id: string },
  depositId: string,
  info: DepositInfo,
): Promise<void> {
  if (info.status === 'COMPLETED') {
    // Atomic claim — only the responder that actually flips pending→paid
    // proceeds, so concurrent polls cannot double-audit the same deposit.
    const { data: claimed } = await supabaseAdmin
      .from('broadcasts')
      .update({ payment_status: 'paid', status: 'paid' })
      .eq('id', broadcast.id)
      .eq('payment_status', 'pending')
      .select('id')
      .maybeSingle()
    if (!claimed) {
      console.log(`[payment] poll: broadcast=${broadcast.id} already settled — skipping (idempotent)`)
      return
    }

    await writeAudit({
      action:          'broadcast_paid',
      targetType:      'customer',
      targetId:        broadcast.sender_id,
      performedBy:     broadcast.sender_id,
      performedByType: 'system',
      metadata: {
        broadcast_id:  broadcast.id,
        deposit_id:    depositId,
        via:           'status_poll',
        correspondent: info.correspondent,
        // Queryable marker for the gap this leaves — see the log line below.
        fan_out:       'not_triggered_by_poll',
      },
    })

    // Loud on purpose: the sender has paid and NOTHING has gone out yet.
    console.error(
      `[payments/status] broadcast=${broadcast.id} reconciled to PAID by polling, but the ` +
      `fan-out is webhook-only — it is stuck at status=paid and nothing has been sent. ` +
      `Recover with: POST /api/broadcasts/${broadcast.id}/send ` +
      `(Authorization: Bearer <INTERNAL_API_SECRET>).`,
    )
  } else if (info.status === 'FAILED' || info.status === 'REJECTED') {
    const { data: claimed } = await supabaseAdmin
      .from('broadcasts')
      .update({ payment_status: 'failed', status: 'failed' })
      .eq('id', broadcast.id)
      .eq('payment_status', 'pending')
      .select('id')
      .maybeSingle()
    if (!claimed) return

    await writeAudit({
      action:          'broadcast_payment_failed',
      targetType:      'customer',
      targetId:        broadcast.sender_id,
      performedBy:     broadcast.sender_id,
      performedByType: 'system',
      metadata: {
        broadcast_id: broadcast.id,
        deposit_id:   depositId,
        via:          'status_poll',
        reason:       info.failureReason ?? null,
      },
    })
  }
}

// Settle a paid promotion. Same mirror of the webhook's transitions. A
// promotion has no fan-out, so polling settles it completely: paid promotions
// land in pending_review for an admin to vet before they appear in the feed.
async function reconcilePromotion(
  promo: { id: string; promoter_id: string },
  depositId: string,
  info: DepositInfo,
): Promise<void> {
  const terminal =
    info.status === 'COMPLETED' ? { payment_status: 'paid',   status: 'pending_review' } :
    info.status === 'FAILED' || info.status === 'REJECTED'
      ? { payment_status: 'failed', status: 'rejected' }
      : null
  if (!terminal) return

  const { data: claimed } = await supabaseAdmin
    .from('promotions')
    .update({ ...terminal, updated_at: new Date().toISOString() })
    .eq('id', promo.id)
    .eq('payment_status', 'pending')
    .select('id')
    .maybeSingle()
  if (!claimed) {
    console.log(`[payment] poll: promotion=${promo.id} already settled — skipping (idempotent)`)
    return
  }

  await writeAudit({
    action:          terminal.payment_status === 'paid' ? 'promotion_paid' : 'promotion_payment_failed',
    targetType:      'promotion',
    targetId:        promo.id,
    performedBy:     promo.promoter_id,
    performedByType: 'system',
    metadata: {
      deposit_id:    depositId,
      via:           'status_poll',
      correspondent: info.correspondent,
      reason:        info.status === 'COMPLETED' ? undefined : (info.failureReason ?? null),
    },
  })
  console.log(`[payment] poll → promotion=${promo.id} ${terminal.payment_status} (status=${terminal.status})`)
}

// GET /api/payments/status/[depositId]
// Polled by the checkout flow every 3s. Returns a small JSON envelope and
// also reconciles the local row when PawaPay reports a terminal status — the
// webhook is the primary update path, but polling provides a safety net for
// environments where webhooks are flaky (sandbox, local tunnels, etc.).
//
// Covers orders, event reservations, broadcasts and promotions. Reconciling
// here is safe in a way the webhook is not: the status comes from PawaPay over
// an authenticated server-to-server call (checkDepositStatus), never from the
// caller's own request body.
export async function GET(_req: NextRequest, { params }: { params: { depositId: string } }) {
  const { depositId } = params
  if (!depositId) return NextResponse.json({ error: 'depositId required' }, { status: 400 })

  let info
  try {
    info = await checkDepositStatus(depositId)
  } catch (e) {
    console.error('[payments/status] check failed:', (e as Error).message)
    return NextResponse.json({ error: 'PawaPay unavailable' }, { status: 502 })
  }

  // Defensive sync: if the webhook has already marked the local row, keep
  // the DB as the source of truth. Otherwise, write through on terminal
  // statuses so the client poll alone is enough to confirm payment.
  // We also fan out the customer + vendor WhatsApp from here so payment
  // notifications don't depend on PawaPay's webhook reaching the app
  // (the sandbox sometimes drops them, and self-hosted Twilio sandboxes
  // need a public URL). Both writers guard on payment_status='pending'
  // so only the first responder notifies.
  const { data: order } = await supabaseAdmin
    .from('orders')
    .select('id, payment_status')
    .eq('payment_id', depositId)
    .maybeSingle()

  // Event-reservation fallback when the deposit isn't on an order.
  const { data: reservation } = order ? { data: null } : await supabaseAdmin
    .from('event_reservations')
    .select('id, event_id, payment_status, quantity')
    .eq('payment_id', depositId)
    .maybeSingle()

  console.log(`[payment] poll tick: deposit=${depositId} pawapay.status=${info.status} db.order=${order?.id ?? '<none>'} db.reservation=${reservation?.id ?? '<none>'} db.payment_status=${order?.payment_status ?? reservation?.payment_status ?? '<none>'}`)

  if (order && order.payment_status === 'pending') {
    if (info.status === 'COMPLETED') {
      console.log(`[payment] polling detected status: COMPLETED — order=${order.id} deposit=${depositId}`)
      await supabaseAdmin
        .from('orders')
        .update({ payment_status: 'paid', payment_at: new Date().toISOString() })
        .eq('id', order.id)
      await writeAudit({
        action:     'payment_completed',
        targetType: 'order',
        targetId:   order.id,
        metadata:   { deposit_id: depositId, via: 'status_poll', correspondent: info.correspondent },
      })
      console.log(`[payment] poll → paid (db flipped): order=${order.id} deposit=${depositId}`)
      await notifyPaidOrder(order.id, info.correspondent)
      console.log(`[payment] notifyPaidOrder complete: order=${order.id}`)
    } else if (info.status === 'FAILED' || info.status === 'REJECTED') {
      console.log(`[payment] polling detected status: ${info.status} — order=${order.id} deposit=${depositId}`)
      await supabaseAdmin
        .from('orders')
        .update({ payment_status: 'failed' })
        .eq('id', order.id)
    }
  } else if (order && info.status === 'COMPLETED' && order.payment_status === 'paid') {
    console.log(`[payment] poll: order=${order.id} already paid — skipping notify (idempotent)`)
  } else if (reservation && reservation.payment_status === 'pending') {
    if (info.status === 'COMPLETED') {
      console.log(`[payment] polling detected status: COMPLETED — reservation=${reservation.id} deposit=${depositId}`)
      await supabaseAdmin
        .from('event_reservations')
        .update({ payment_status: 'paid', updated_at: new Date().toISOString() })
        .eq('id', reservation.id)
      await writeAudit({
        action:     'event_payment_completed',
        targetType: 'event_reservation',
        targetId:   reservation.id,
        metadata:   { deposit_id: depositId, via: 'status_poll', correspondent: info.correspondent, event_id: reservation.event_id },
      })
      await notifyPaidReservation(reservation.id, info.correspondent)
      console.log(`[payment] notifyPaidReservation complete: reservation=${reservation.id}`)
    } else if (info.status === 'FAILED' || info.status === 'REJECTED') {
      // Free the seats we held during the USSD window.
      const { data: ev } = await supabaseAdmin
        .from('events').select('tickets_sold').eq('id', reservation.event_id).maybeSingle()
      const sold = Number(ev?.tickets_sold ?? 0)
      await Promise.all([
        supabaseAdmin
          .from('event_reservations')
          .update({ payment_status: 'failed', updated_at: new Date().toISOString() })
          .eq('id', reservation.id),
        supabaseAdmin
          .from('events')
          .update({ tickets_sold: Math.max(0, sold - Number(reservation.quantity ?? 0)) })
          .eq('id', reservation.event_id),
      ])
    }
  }

  // ── Broadcasts + promotions ───────────────────────────────────────────────
  // The webhook is otherwise the ONLY writer that settles these two, so a
  // callback that never arrives — or, once signatures are enforced, one that
  // is wrongly rejected — would strand a real payment with no recovery path.
  // Only reached when the deposit belongs to neither an order nor a
  // reservation, so the money paths above are untouched.
  if (!order && !reservation) {
    const { data: broadcast } = await supabaseAdmin
      .from('broadcasts')
      .select('id, sender_id, payment_status')
      .eq('payment_id', depositId)
      .maybeSingle()

    if (broadcast) {
      console.log(`[payment] poll tick: deposit=${depositId} pawapay.status=${info.status} db.broadcast=${broadcast.id} db.payment_status=${broadcast.payment_status}`)
      await reconcileBroadcast(broadcast as { id: string; sender_id: string }, depositId, info)
    } else {
      const { data: promo } = await supabaseAdmin
        .from('promotions')
        .select('id, promoter_id, payment_status')
        .eq('payment_id', depositId)
        .maybeSingle()
      if (promo) {
        console.log(`[payment] poll tick: deposit=${depositId} pawapay.status=${info.status} db.promotion=${promo.id} db.payment_status=${promo.payment_status}`)
        await reconcilePromotion(promo as { id: string; promoter_id: string }, depositId, info)
      }
    }
  }

  // Map PawaPay verbs to a simple lifecycle the client can switch on.
  const phase: 'pending' | 'paid' | 'failed' =
    info.status === 'COMPLETED' ? 'paid' :
    info.status === 'FAILED' || info.status === 'REJECTED' ? 'failed' :
    'pending'

  return NextResponse.json({
    ok:        true,
    depositId,
    phase,
    rawStatus: info.status,
    failureReason: info.failureReason,
  })
}
