import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromRequest } from '@/lib/auth'
import { validateVoucher } from '@/lib/vouchers'

export const dynamic = 'force-dynamic'

// POST /api/events/[id]/vouchers/validate  { code, orderTotal }
// Customer-facing preview: validates a promo code against THIS event and
// returns the discount + final total so the reserve/pay UI can show the
// struck-through price. Guests allowed (no per-customer claim check). Does NOT
// mutate — the reserve/pay route re-validates and consumes at booking time.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionFromRequest(req)
  const customerId = session?.role === 'customer' ? session.id : null

  const body = await req.json().catch(() => ({}))
  const code = typeof body?.code === 'string' ? body.code.trim() : ''
  const orderTotal = Math.max(0, Math.round(Number(body?.orderTotal ?? 0)) || 0)
  if (!code) return NextResponse.json({ ok: false, message: 'Code requis / Code required' }, { status: 400 })
  if (orderTotal <= 0) {
    return NextResponse.json({ ok: false, message: 'Ce billet est gratuit / This ticket is free' }, { status: 400 })
  }

  const result = await validateVoucher(code, { customerId, eventId: params.id, orderTotal })
  if (!result.ok) {
    return NextResponse.json({ ok: false, reason: result.reason, message: result.message }, { status: 200 })
  }

  return NextResponse.json({
    ok: true,
    voucher: {
      id:             result.voucher.id,
      code:           result.voucher.code,
      discount_type:  result.voucher.discount_type,
      discount_value: result.voucher.discount_value,
    },
    discount:   result.discount,
    finalTotal: result.finalTotal,
  })
}
