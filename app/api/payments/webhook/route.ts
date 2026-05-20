import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { writeAudit } from '@/lib/audit'
import { verifyWebhookSignature, type PawaPayCorrespondent } from '@/lib/pawapay'
import { sendWhatsApp } from '@/lib/whatsapp'
import { notifyPaidOrder, notifyPaidReservation } from '@/lib/payments-notify'

export const dynamic = 'force-dynamic'

// POST /api/payments/webhook
// PawaPay calls this whenever a deposit (or payout) reaches a terminal status.
// Body shape (deposit):
//   { depositId, status: 'COMPLETED'|'FAILED'|'REJECTED', amount, currency,
//     correspondent, failureReason?: { failureMessage } }
//
// We:
//   1. Verify the RFC-9421 Content-Digest header in production; sandbox
//      callbacks bypass verification (PawaPay sandbox is unsigned).
//   2. Look up the order by orders.payment_id = depositId.
//   3. Write the new status + audit row.
//   4. Notify customer + vendors over WhatsApp on success/failure.
//
// Idempotent: a duplicate COMPLETED callback for an already-paid order is a
// no-op except for re-sending the notification (skipped — see early return).
export async function POST(req: NextRequest) {
  const rawBody = await req.text()
  const contentDigest = req.headers.get('content-digest')

  if (!verifyWebhookSignature(rawBody, contentDigest)) {
    console.warn('[payments/webhook] Content-Digest verification failed')
    return NextResponse.json({ error: 'invalid signature' }, { status: 401 })
  }

  let payload: {
    depositId?: string
    payoutId?:  string
    status?:    string
    amount?:    string | number
    currency?:  string
    correspondent?: PawaPayCorrespondent
    failureReason?: { failureMessage?: string }
  }
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }

  // ── Payout callback path (admin payouts) ───────────────────────────────────
  if (payload.payoutId && !payload.depositId) {
    const action = payload.status === 'COMPLETED' ? 'payout_completed' : 'payout_failed'
    await writeAudit({
      action,
      targetType: 'order',
      targetId:   payload.payoutId,
      metadata:   { payout_id: payload.payoutId, status: payload.status, amount: payload.amount, currency: payload.currency },
    })
    return NextResponse.json({ ok: true })
  }

  // ── Deposit callback path ──────────────────────────────────────────────────
  const depositId = payload.depositId
  if (!depositId) return NextResponse.json({ error: 'no depositId' }, { status: 400 })

  const { data: order } = await supabaseAdmin
    .from('orders')
    .select('id, payment_status, customer_phone')
    .eq('payment_id', depositId)
    .maybeSingle()

  if (order) {
    if (order.payment_status === 'paid' || order.payment_status === 'failed') {
      return NextResponse.json({ ok: true, ignored: 'already settled' })
    }

    if (payload.status === 'COMPLETED') {
      await supabaseAdmin
        .from('orders')
        .update({ payment_status: 'paid', payment_at: new Date().toISOString() })
        .eq('id', order.id)

      await writeAudit({
        action:     'payment_completed',
        targetType: 'order',
        targetId:   order.id,
        metadata:   { deposit_id: depositId, amount: payload.amount, currency: payload.currency, correspondent: payload.correspondent },
      })

      console.log(`[payment] webhook → paid: order=${order.id} deposit=${depositId}`)
      await notifyPaidOrder(order.id, payload.correspondent)
    } else if (payload.status === 'FAILED' || payload.status === 'REJECTED') {
      await supabaseAdmin
        .from('orders')
        .update({ payment_status: 'failed' })
        .eq('id', order.id)

      await writeAudit({
        action:     'payment_failed',
        targetType: 'order',
        targetId:   order.id,
        metadata:   {
          deposit_id: depositId,
          reason:     payload.failureReason?.failureMessage ?? null,
          amount:     payload.amount,
          currency:   payload.currency,
        },
      })

      if (order.customer_phone) {
        await sendWhatsApp(order.customer_phone, [
          `❌ *Paiement échoué / Payment failed*`,
          ``,
          `Votre paiement n'a pas abouti. Envoyez "payer" pour réessayer ou contactez le restaurant.`,
          `Your payment didn't go through. Send "pay" to retry or contact the restaurant.`,
        ].join('\n')).catch(() => null)
      }
    }

    return NextResponse.json({ ok: true })
  }

  // ── Broadcast fallback ─────────────────────────────────────────────────────
  // Same idempotent guard + audit shape, but for paid broadcasts. On
  // COMPLETED we mark paid and fire the fan-out via the /send route.
  const { data: broadcast } = await supabaseAdmin
    .from('broadcasts')
    .select('id, sender_id, payment_status, status')
    .eq('payment_id', depositId)
    .maybeSingle()

  if (broadcast) {
    if (broadcast.payment_status === 'paid' || broadcast.payment_status === 'failed') {
      return NextResponse.json({ ok: true, ignored: 'already settled' })
    }

    if (payload.status === 'COMPLETED') {
      await supabaseAdmin
        .from('broadcasts')
        .update({ payment_status: 'paid', status: 'paid' })
        .eq('id', broadcast.id)

      await writeAudit({
        action:          'broadcast_paid',
        targetType:      'customer',
        targetId:        broadcast.sender_id,
        performedBy:     broadcast.sender_id,
        performedByType: 'system',
        metadata: {
          broadcast_id: broadcast.id,
          deposit_id:   depositId,
          amount:       payload.amount,
          currency:     payload.currency,
        },
      })

      // Fire-and-await the fan-out. We're already in a background webhook,
      // so blocking until WhatsApp finishes is fine and keeps audit ordering
      // deterministic.
      const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? 'https://streetmenu.vercel.app'
      try {
        await fetch(`${baseUrl}/api/broadcasts/${broadcast.id}/send`, { method: 'POST' })
      } catch (e) {
        console.error('[payments/webhook] broadcast send failed:', (e as Error).message)
      }
    } else if (payload.status === 'FAILED' || payload.status === 'REJECTED') {
      await supabaseAdmin
        .from('broadcasts')
        .update({ payment_status: 'failed', status: 'failed' })
        .eq('id', broadcast.id)

      await writeAudit({
        action:          'broadcast_payment_failed',
        targetType:      'customer',
        targetId:        broadcast.sender_id,
        performedBy:     broadcast.sender_id,
        performedByType: 'system',
        metadata: {
          broadcast_id: broadcast.id,
          deposit_id:   depositId,
          reason:       payload.failureReason?.failureMessage ?? null,
        },
      })
    }

    return NextResponse.json({ ok: true })
  }

  // ── Event-reservation fallback ─────────────────────────────────────────────
  // Same idempotent guard + audit shape as orders, but with event_reservations
  // as the row and notifyPaidReservation as the fan-out.
  const { data: reservation } = await supabaseAdmin
    .from('event_reservations')
    .select('id, event_id, payment_status, customer_phone, total_price, quantity')
    .eq('payment_id', depositId)
    .maybeSingle()

  if (!reservation) {
    console.warn(`[payments/webhook] no order OR reservation matches depositId=${depositId}`)
    return NextResponse.json({ ok: true, ignored: 'unknown deposit' })
  }
  if (reservation.payment_status === 'paid' || reservation.payment_status === 'failed') {
    return NextResponse.json({ ok: true, ignored: 'already settled' })
  }

  if (payload.status === 'COMPLETED') {
    await supabaseAdmin
      .from('event_reservations')
      .update({ payment_status: 'paid', updated_at: new Date().toISOString() })
      .eq('id', reservation.id)

    await writeAudit({
      action:     'event_payment_completed',
      targetType: 'event_reservation',
      targetId:   reservation.id,
      metadata:   {
        deposit_id:    depositId,
        amount:        payload.amount,
        currency:      payload.currency,
        correspondent: payload.correspondent,
        event_id:      reservation.event_id,
      },
    })

    console.log(`[payment] webhook → reservation paid: reservation=${reservation.id} deposit=${depositId}`)
    await notifyPaidReservation(reservation.id, payload.correspondent)
  } else if (payload.status === 'FAILED' || payload.status === 'REJECTED') {
    // Release the held seats so a failed payment doesn't permanently
    // inflate tickets_sold. Best-effort: read current, subtract, write.
    const { data: ev } = await supabaseAdmin
      .from('events').select('tickets_sold').eq('id', reservation.event_id).maybeSingle()
    const sold = Number(ev?.tickets_sold ?? 0)
    const nextSold = Math.max(0, sold - Number(reservation.quantity ?? 0))

    await Promise.all([
      supabaseAdmin
        .from('event_reservations')
        .update({ payment_status: 'failed', updated_at: new Date().toISOString() })
        .eq('id', reservation.id),
      supabaseAdmin
        .from('events').update({ tickets_sold: nextSold }).eq('id', reservation.event_id),
    ])

    await writeAudit({
      action:     'event_payment_failed',
      targetType: 'event_reservation',
      targetId:   reservation.id,
      metadata:   {
        deposit_id: depositId,
        reason:     payload.failureReason?.failureMessage ?? null,
        amount:     payload.amount,
        currency:   payload.currency,
        event_id:   reservation.event_id,
      },
    })

    if (reservation.customer_phone) {
      await sendWhatsApp(reservation.customer_phone, [
        `❌ *Paiement échoué / Payment failed*`,
        ``,
        `Votre paiement pour la réservation n'a pas abouti. Réessayez ou contactez l'organisateur.`,
        `Your reservation payment didn't go through. Retry or contact the organizer.`,
      ].join('\n')).catch(() => null)
    }
  }

  return NextResponse.json({ ok: true })
}
