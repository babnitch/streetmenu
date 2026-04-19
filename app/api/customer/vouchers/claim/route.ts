import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'
import { deriveStatus, type VoucherRow } from '@/lib/vouchers'

export const dynamic = 'force-dynamic'

// POST /api/customer/vouchers/claim { code }
// Customer enters a voucher code to claim it into their wallet. Claim
// != use; applying the discount at checkout is a separate step.
export async function POST(req: NextRequest) {
  const session = getSessionFromRequest(req)
  if (!session || session.role !== 'customer') {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }

  const { code } = await req.json().catch(() => ({}))
  const normalized = String(code ?? '').trim().toUpperCase()
  if (!normalized) {
    return NextResponse.json({ error: 'Code requis / Code required' }, { status: 400 })
  }

  const { data: v } = await supabaseAdmin
    .from('vouchers')
    .select('id, code, discount_type, discount_value, min_order, max_uses, current_uses, is_active, expires_at, city, restaurant_id')
    .eq('code', normalized)
    .maybeSingle()

  if (!v) {
    return NextResponse.json({ error: 'Code introuvable / Code not found' }, { status: 404 })
  }
  const voucher = v as unknown as VoucherRow

  const status = deriveStatus(voucher)
  if (status !== 'active') {
    return NextResponse.json({ error: `Code ${status === 'inactive' ? 'désactivé' : status === 'expired' ? 'expiré' : 'épuisé'} / ${status}` }, { status: 410 })
  }

  // Has the customer already claimed (unused) or used this voucher up to
  // the per-customer limit?
  const { data: prior } = await supabaseAdmin
    .from('customer_vouchers')
    .select('id, used_at')
    .eq('customer_id', session.id)
    .eq('voucher_id', voucher.id)
  const totalClaims = prior?.length ?? 0
  const limit = (voucher.per_customer_max ?? 1)
  if (limit > 0 && totalClaims >= limit) {
    return NextResponse.json({ error: 'Déjà réclamé / Already claimed' }, { status: 409 })
  }

  // Ensure there's at least one unused claim ready for checkout. If a prior
  // used claim exists but the limit allows more, we still create a new one.
  const { data: inserted, error: insErr } = await supabaseAdmin
    .from('customer_vouchers')
    .insert({ customer_id: session.id, voucher_id: voucher.id })
    .select('id')
    .single()

  if (insErr) {
    console.error('[voucher-claim] insert failed:', insErr.message)
    return NextResponse.json({ error: insErr.message }, { status: 500 })
  }

  await writeAudit({
    action: 'voucher_claimed',
    targetType: 'voucher',
    targetId: voucher.id,
    performedBy: session.id,
    performedByType: 'customer',
    metadata: { code: voucher.code, customer_voucher_id: inserted.id },
  })

  return NextResponse.json({
    ok: true,
    voucher: {
      id: voucher.id,
      code: voucher.code,
      discount_type: voucher.discount_type,
      discount_value: voucher.discount_value,
      restaurant_id: voucher.restaurant_id,
      expires_at: voucher.expires_at,
      min_order: voucher.min_order,
    },
  })
}
