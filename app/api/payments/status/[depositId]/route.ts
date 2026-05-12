import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { checkDepositStatus } from '@/lib/pawapay'
import { notifyPaidOrder } from '@/lib/payments-notify'
import { writeAudit } from '@/lib/audit'

export const dynamic = 'force-dynamic'

// GET /api/payments/status/[depositId]
// Polled by the checkout flow every 3s. Returns a small JSON envelope and
// also reconciles the local orders.payment_status when PawaPay reports a
// terminal status — the webhook is the primary update path, but polling
// provides a safety net for environments where webhooks are flaky
// (sandbox, local tunnels, etc.).
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

  console.log(`[payment] poll tick: deposit=${depositId} pawapay.status=${info.status} db.order=${order?.id ?? '<none>'} db.payment_status=${order?.payment_status ?? '<none>'}`)

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
    // Already settled by the webhook or a previous poll — quiet skip, but
    // log it once so we can confirm the guard is doing its job in dev.
    console.log(`[payment] poll: order=${order.id} already paid — skipping notify (idempotent)`)
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
