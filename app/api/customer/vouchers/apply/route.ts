import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromRequest } from '@/lib/auth'
import { validateVoucher } from '@/lib/vouchers'

export const dynamic = 'force-dynamic'

// POST /api/customer/vouchers/apply
// Body: { code, restaurantId, orderTotal }
// Validates a voucher against a prospective order and returns the discount
// the client should display. Does NOT commit anything; actual consumption
// happens when the order is written.
//
// Unauthenticated (guest) checkouts are allowed — per-customer limit is
// simply skipped when no session is present.
export async function POST(req: NextRequest) {
  const session = getSessionFromRequest(req)
  const customerId = session?.role === 'customer' ? session.id : null

  const body = await req.json().catch(() => ({}))
  const code = String(body.code ?? '').trim().toUpperCase()
  const restaurantId = typeof body.restaurantId === 'string' ? body.restaurantId : undefined
  const orderTotal = Number(body.orderTotal)

  if (!code || !restaurantId || !Number.isFinite(orderTotal) || orderTotal <= 0) {
    return NextResponse.json({ error: 'Champs requis: code, restaurantId, orderTotal / Missing fields' }, { status: 400 })
  }

  // Look up customer city when available for city-restricted vouchers.
  let city: string | null = null
  if (customerId) {
    const { supabaseAdmin } = await import('@/lib/supabaseAdmin')
    const { data } = await supabaseAdmin.from('customers').select('city').eq('id', customerId).maybeSingle()
    city = data?.city ?? null
  }

  const result = await validateVoucher(code, { customerId, restaurantId, orderTotal, city })
  if (!result.ok) {
    return NextResponse.json({ error: result.message, reason: result.reason }, { status: 400 })
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
