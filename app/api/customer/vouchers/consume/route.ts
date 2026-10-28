import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

// POST /api/customer/vouchers/consume — no longer does anything (V0).
//
// The voucher is now used up by /api/orders/create, with the order, from
// the server's own validation. This route stays only so a checkout tab
// opened before the change gets an answer; acting on it would count the
// voucher twice.
export async function POST() {
  return NextResponse.json({ ok: true, consumed_by: 'orders/create' })
}
