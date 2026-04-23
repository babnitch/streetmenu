import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { writeAudit } from '@/lib/audit'
import { verifyWebhookSignature, mnoLabel, type PawaPayCorrespondent } from '@/lib/pawapay'
import { sendWhatsApp } from '@/lib/whatsapp'
import { vendorRecipients } from '@/lib/whatsapp/ordering'

export const dynamic = 'force-dynamic'

// POST /api/payments/webhook
// PawaPay calls this whenever a deposit (or payout) reaches a terminal status.
// Body shape (deposit):
//   { depositId, status: 'COMPLETED'|'FAILED'|'REJECTED', amount, currency,
//     correspondent, failureReason?: { failureMessage } }
//
// We:
//   1. Verify the HMAC signature (rejects unsigned requests in production).
//   2. Look up the order by orders.payment_id = depositId.
//   3. Write the new status + audit row.
//   4. Notify customer + vendors over WhatsApp on success/failure.
//
// Idempotent: a duplicate COMPLETED callback for an already-paid order is a
// no-op except for re-sending the notification (skipped — see early return).
export async function POST(req: NextRequest) {
  const rawBody = await req.text()
  const signature = req.headers.get('signature')
                  ?? req.headers.get('x-pawapay-signature')
                  ?? req.headers.get('x-signature')

  if (!verifyWebhookSignature(rawBody, signature)) {
    console.warn('[payments/webhook] signature verification failed')
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
    .select('id, restaurant_id, customer_phone, customer_name, items, total_price, payment_status')
    .eq('payment_id', depositId)
    .maybeSingle()

  if (!order) {
    console.warn(`[payments/webhook] no order matches depositId=${depositId}`)
    return NextResponse.json({ ok: true, ignored: 'unknown deposit' })
  }

  // Already settled — make this idempotent so PawaPay retries don't double-notify.
  if (order.payment_status === 'paid' || order.payment_status === 'failed') {
    return NextResponse.json({ ok: true, ignored: 'already settled' })
  }

  const { data: restaurant } = await supabaseAdmin
    .from('restaurants')
    .select('id, name')
    .eq('id', order.restaurant_id)
    .single()
  const restName = restaurant?.name ?? '—'

  if (payload.status === 'COMPLETED') {
    await supabaseAdmin
      .from('orders')
      .update({
        payment_status: 'paid',
        payment_at:     new Date().toISOString(),
      })
      .eq('id', order.id)

    await writeAudit({
      action:     'payment_completed',
      targetType: 'order',
      targetId:   order.id,
      metadata:   { deposit_id: depositId, amount: payload.amount, currency: payload.currency, correspondent: payload.correspondent },
    })

    // Customer confirmation
    if (order.customer_phone) {
      await sendWhatsApp(order.customer_phone, [
        `✅ *Paiement confirmé! / Payment confirmed!*`,
        ``,
        `🏪 ${restName}`,
        `💰 ${Number(order.total_price).toLocaleString()} FCFA`,
        ``,
        `Votre commande est confirmée et le restaurant prépare votre repas.`,
        `Your order is confirmed and the restaurant is preparing your meal.`,
      ].join('\n')).catch(() => null)
    }

    // Vendor notification (paid order is more urgent than a reservation)
    const recipients = await vendorRecipients(order.restaurant_id)
    const id4 = order.id.replace(/-/g, '').slice(-4).toUpperCase()
    const mno = payload.correspondent ? mnoLabel(payload.correspondent) : 'mobile money'
    const msg = [
      `💰 *PAIEMENT REÇU / PAYMENT RECEIVED*`,
      ``,
      `🧾 Commande #${id4}`,
      `👤 ${order.customer_name}`,
      `📱 ${order.customer_phone}`,
      `💳 ${mno}`,
      `💰 ${Number(order.total_price).toLocaleString()} FCFA`,
      ``,
      `La commande est payée — préparez-la! / Order is paid — prepare it!`,
    ].join('\n')
    await Promise.allSettled(recipients.map(p => sendWhatsApp(p, msg)))
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
