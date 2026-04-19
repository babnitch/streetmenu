import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'
import { deriveStatus } from '@/lib/vouchers'

export const dynamic = 'force-dynamic'

// GET /api/admin/vouchers
// List every voucher with derived status + restaurant name.
export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req)
  if (!session || !['super_admin', 'admin', 'moderator'].includes(session.role)) {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }

  const { data, error } = await supabaseAdmin
    .from('vouchers')
    .select('id, code, discount_type, discount_value, min_order, max_uses, current_uses, is_active, expires_at, city, restaurant_id, created_at, restaurants(name)')
    .order('created_at', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const vouchers = (data ?? []).map(v => ({
    ...v,
    status: deriveStatus(v),
    restaurant_name: (v.restaurants as unknown as { name: string } | null)?.name ?? null,
  }))
  return NextResponse.json({ vouchers })
}

// POST — admin creates a voucher. Recorded as 'voucher_created' in audit_log.
export async function POST(req: NextRequest) {
  const session = getSessionFromRequest(req)
  if (!session || !['super_admin', 'admin'].includes(session.role)) {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }

  const payload = await req.json()
  let code = (payload.code ?? '').toString().trim().toUpperCase()
  // Auto-generate TCHOP-XXXX if the admin didn't specify one.
  if (!code) {
    code = 'TCHOP-' + Math.random().toString(36).slice(2, 6).toUpperCase()
  }
  const discountType = payload.discount_type
  const discountValue = Number(payload.discount_value)

  if (!['percent', 'fixed'].includes(discountType) || !Number.isFinite(discountValue)) {
    return NextResponse.json({ error: 'Champs manquants / Missing fields' }, { status: 400 })
  }

  // per_customer_max column is optional until the voucher-system migration
  // runs. We silently omit it when not provided so this route works on
  // either schema version.
  const row: Record<string, unknown> = {
    code,
    discount_type:  discountType,
    discount_value: discountValue,
    min_order:      Number(payload.min_order) || 0,
    max_uses:       payload.max_uses != null && payload.max_uses !== '' ? parseInt(String(payload.max_uses), 10) : null,
    expires_at:     payload.expires_at || null,
    city:           payload.city ? String(payload.city).trim() : null,
    restaurant_id:  payload.restaurant_id || null,
    is_active:      payload.is_active !== false,
  }

  const { data, error } = await supabaseAdmin
    .from('vouchers')
    .insert(row)
    .select('*')
    .single()

  if (error) {
    if (error.code === '23505') {
      return NextResponse.json({ error: 'Code déjà utilisé / Code already used' }, { status: 409 })
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  await writeAudit({
    action: 'voucher_created',
    targetType: 'voucher',
    targetId: data.id,
    performedBy: session.id,
    performedByType: session.role,
    metadata: {
      code: data.code,
      discount_type: data.discount_type,
      discount_value: data.discount_value,
      is_active: data.is_active,
      city: data.city,
    },
  })

  return NextResponse.json({ ok: true, voucher: data })
}
