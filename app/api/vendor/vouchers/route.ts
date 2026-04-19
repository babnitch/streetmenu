import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'
import { deriveStatus } from '@/lib/vouchers'

export const dynamic = 'force-dynamic'

// Vendor voucher management. Scoped to the restaurants the current
// customer either owns directly (restaurants.customer_id) or is an active
// owner/manager for via restaurant_team. Staff role cannot create vouchers.

async function allowedRestaurantIds(customerId: string): Promise<Set<string>> {
  const [direct, team] = await Promise.all([
    supabaseAdmin.from('restaurants').select('id').eq('customer_id', customerId)
      .is('deleted_at', null).neq('status', 'deleted'),
    supabaseAdmin.from('restaurant_team')
      .select('restaurants(id, deleted_at, status), role')
      .eq('customer_id', customerId).eq('status', 'active')
      .in('role', ['owner', 'manager']),
  ])
  const ids = new Set<string>()
  for (const r of direct.data ?? []) ids.add(r.id)
  for (const entry of team.data ?? []) {
    const r = entry.restaurants as unknown as { id: string; deleted_at: string | null; status: string } | null
    if (!r) continue
    if (r.deleted_at || r.status === 'deleted') continue
    ids.add(r.id)
  }
  return ids
}

// GET — list vouchers for every restaurant this vendor runs.
export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req)
  if (!session || session.role !== 'customer') {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }
  const ids = await allowedRestaurantIds(session.id)
  if (ids.size === 0) return NextResponse.json({ vouchers: [] })

  const { data, error } = await supabaseAdmin
    .from('vouchers')
    .select('id, code, discount_type, discount_value, min_order, max_uses, current_uses, is_active, expires_at, city, restaurant_id, created_at, restaurants(name)')
    .in('restaurant_id', Array.from(ids))
    .order('created_at', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const vouchers = (data ?? []).map(v => ({
    ...v,
    status: deriveStatus(v),
    restaurant_name: (v.restaurants as unknown as { name: string } | null)?.name ?? null,
  }))
  return NextResponse.json({ vouchers })
}

// POST — vendor creates a voucher for one of their restaurants. Always
// restaurant-scoped (never platform-wide); city is ignored.
export async function POST(req: NextRequest) {
  const session = getSessionFromRequest(req)
  if (!session || session.role !== 'customer') {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }

  const payload = await req.json().catch(() => ({}))
  const restaurantId = payload.restaurant_id
  if (typeof restaurantId !== 'string' || !restaurantId) {
    return NextResponse.json({ error: 'restaurant_id requis / required' }, { status: 400 })
  }

  const ids = await allowedRestaurantIds(session.id)
  if (!ids.has(restaurantId)) {
    return NextResponse.json({ error: 'Restaurant non autorisé / Not your restaurant' }, { status: 403 })
  }

  let code = (payload.code ?? '').toString().trim().toUpperCase()
  if (!code) code = 'TCHOP-' + Math.random().toString(36).slice(2, 6).toUpperCase()

  const discountType = payload.discount_type
  const discountValue = Number(payload.discount_value)
  if (!['percent', 'fixed'].includes(discountType) || !Number.isFinite(discountValue)) {
    return NextResponse.json({ error: 'Champs manquants / Missing fields' }, { status: 400 })
  }

  const row: Record<string, unknown> = {
    code,
    discount_type:  discountType,
    discount_value: discountValue,
    min_order:      Number(payload.min_order) || 0,
    max_uses:       payload.max_uses != null && payload.max_uses !== '' ? parseInt(String(payload.max_uses), 10) : null,
    expires_at:     payload.expires_at || null,
    restaurant_id:  restaurantId,
    is_active:      payload.is_active !== false,
  }

  const { data, error } = await supabaseAdmin
    .from('vouchers').insert(row).select('*').single()
  if (error) {
    if (error.code === '23505') return NextResponse.json({ error: 'Code déjà utilisé / Code already used' }, { status: 409 })
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  await writeAudit({
    action: 'voucher_created',
    targetType: 'voucher',
    targetId: data.id,
    performedBy: session.id,
    performedByType: 'vendor',
    metadata: { code: data.code, restaurant_id: restaurantId, discount_type: data.discount_type, discount_value: data.discount_value },
  })

  return NextResponse.json({ ok: true, voucher: data })
}
