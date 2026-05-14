import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { validateVoucher } from '@/lib/vouchers'
import { writeAudit } from '@/lib/audit'

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

  console.log(`[vouchers/apply] in: code=${JSON.stringify(body.code)} normalized=${JSON.stringify(code)} restaurantId=${restaurantId ?? '<missing>'} orderTotal=${orderTotal} customerId=${customerId ?? '<guest>'}`)

  if (!code || !restaurantId || !Number.isFinite(orderTotal) || orderTotal <= 0) {
    return NextResponse.json({ error: 'Champs requis: code, restaurantId, orderTotal / Missing fields' }, { status: 400 })
  }

  // Look up customer city when available for city-restricted vouchers.
  let city: string | null = null
  if (customerId) {
    const { data } = await supabaseAdmin.from('customers').select('city').eq('id', customerId).maybeSingle()
    city = data?.city ?? null
  }

  const result = await validateVoucher(code, { customerId, restaurantId, orderTotal, city })
  if (!result.ok) {
    console.log(`[vouchers/apply] reject reason=${result.reason}`)
    return NextResponse.json({ error: result.message, reason: result.reason }, { status: 400 })
  }

  // Auto-claim — if the customer doesn't already have an unused claim row
  // for this voucher, insert one. Lets the wallet view in /account reflect
  // an "in-flight" use without a separate "claim" tap, and gives consume
  // something to flip to used_at on order completion.
  if (customerId) {
    const { data: existing } = await supabaseAdmin
      .from('customer_vouchers')
      .select('id, used_at')
      .eq('customer_id', customerId)
      .eq('voucher_id', result.voucher.id)
      .is('used_at', null)
      .limit(1)
      .maybeSingle()
    if (!existing) {
      const { data: inserted, error: insErr } = await supabaseAdmin
        .from('customer_vouchers')
        .insert({ customer_id: customerId, voucher_id: result.voucher.id })
        .select('id').single()
      if (insErr) {
        // Don't fail the apply — the discount is still legitimate, the
        // wallet view will be slightly out of sync until consume runs.
        console.warn('[vouchers/apply] auto-claim insert failed:', insErr.message)
      } else {
        console.log(`[vouchers/apply] auto-claimed ${result.voucher.code} for customer=${customerId} cv=${inserted.id}`)
        await writeAudit({
          action:          'voucher_claimed',
          targetType:      'voucher',
          targetId:        result.voucher.id,
          performedBy:     customerId,
          performedByType: 'customer',
          metadata:        { code: result.voucher.code, customer_voucher_id: inserted.id, via: 'checkout_auto_claim' },
        })
      }
    } else {
      console.log(`[vouchers/apply] existing unused claim found cv=${existing.id} — skip auto-claim`)
    }
  }

  console.log(`[vouchers/apply] ok code=${result.voucher.code} discount=${result.discount} finalTotal=${result.finalTotal}`)

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
