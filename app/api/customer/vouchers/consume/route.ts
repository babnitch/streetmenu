import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromRequest } from '@/lib/auth'
import { consumeVoucherForOrder } from '@/lib/vouchers'
import { writeAudit } from '@/lib/audit'
import { supabaseAdmin } from '@/lib/supabaseAdmin'

export const dynamic = 'force-dynamic'

// POST /api/customer/vouchers/consume
// Body: { voucherId, orderId }
// Called after a successful order write to bump vouchers.current_uses and
// flip the caller's customer_voucher claim to used. Idempotent-ish: if
// the order has already been consumed (order_id already on a claim), the
// second call is a no-op. Failures log but don't propagate — the order
// is the source of truth, the voucher bookkeeping is best-effort.
export async function POST(req: NextRequest) {
  const session = getSessionFromRequest(req)
  const customerId = session?.role === 'customer' ? session.id : null

  const body = await req.json().catch(() => ({}))
  const voucherId: string = body.voucherId
  const orderId:   string = body.orderId
  if (!voucherId || !orderId) {
    return NextResponse.json({ error: 'voucherId and orderId required' }, { status: 400 })
  }

  // Verify the order actually exists and belongs to this customer (or to a
  // guest, in which case we only require the voucher_code on the row to
  // match the voucher we're being asked to consume — prevents third parties
  // from inflating someone's usage counter).
  const { data: order } = await supabaseAdmin
    .from('orders').select('id, customer_id, voucher_code, restaurant_id')
    .eq('id', orderId).maybeSingle()
  if (!order) return NextResponse.json({ error: 'order not found' }, { status: 404 })
  if (customerId && order.customer_id && order.customer_id !== customerId) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  const { data: voucher } = await supabaseAdmin
    .from('vouchers').select('code').eq('id', voucherId).maybeSingle()
  if (!voucher || voucher.code !== order.voucher_code) {
    return NextResponse.json({ error: 'voucher does not match order' }, { status: 400 })
  }

  await consumeVoucherForOrder(voucherId, customerId, orderId)
  await writeAudit({
    action: 'voucher_applied',
    targetType: 'voucher',
    targetId: voucherId,
    performedBy: customerId ?? order.id,
    performedByType: customerId ? 'customer' : 'guest',
    metadata: { order_id: orderId, restaurant_id: order.restaurant_id, code: voucher.code },
  })

  return NextResponse.json({ ok: true })
}
