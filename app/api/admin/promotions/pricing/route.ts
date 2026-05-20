import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'
import { PLACEMENTS, type Placement } from '@/lib/promotions'

export const dynamic = 'force-dynamic'

// GET /api/admin/promotions/pricing — active row per placement.
// PATCH — body: { placement, price_per_day?, min_duration_days?, max_duration_days? }
// Updates the active row (single per placement) or creates one when
// no active row exists for that placement.
export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req)
  if (!session || !['super_admin', 'admin', 'moderator'].includes(session.role)) {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }
  const { data } = await supabaseAdmin
    .from('promotion_pricing')
    .select('id, placement, price_per_day, min_duration_days, max_duration_days, is_active, created_at')
    .eq('is_active', true)
  return NextResponse.json({ pricing: data ?? [] })
}

export async function PATCH(req: NextRequest) {
  const session = getSessionFromRequest(req)
  if (!session || !['super_admin', 'admin'].includes(session.role)) {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }

  const body = await req.json().catch(() => ({}))
  const placement = body?.placement as Placement
  if (!PLACEMENTS.includes(placement)) {
    return NextResponse.json({ error: 'placement invalide' }, { status: 400 })
  }

  const updates: Record<string, unknown> = {}
  if (Number.isFinite(body?.price_per_day))     updates.price_per_day     = Math.max(0, Math.round(body.price_per_day))
  if (Number.isFinite(body?.min_duration_days)) updates.min_duration_days = Math.max(1, Math.round(body.min_duration_days))
  if (Number.isFinite(body?.max_duration_days)) updates.max_duration_days = Math.max(1, Math.round(body.max_duration_days))
  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'Aucun champ à mettre à jour' }, { status: 400 })
  }

  const { data: existing } = await supabaseAdmin
    .from('promotion_pricing')
    .select('id, price_per_day, min_duration_days, max_duration_days')
    .eq('placement', placement)
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (existing) {
    const { error } = await supabaseAdmin
      .from('promotion_pricing')
      .update(updates)
      .eq('id', existing.id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    await writeAudit({
      action:          'promotion_pricing_updated',
      targetType:      'admin_user',
      targetId:        existing.id,
      performedBy:     session.id,
      performedByType: session.role,
      previousData:    existing,
      metadata:        { placement, ...updates },
    })
  } else {
    const { data: inserted, error } = await supabaseAdmin
      .from('promotion_pricing')
      .insert({ placement, ...updates, is_active: true })
      .select('id')
      .single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    await writeAudit({
      action:          'promotion_pricing_updated',
      targetType:      'admin_user',
      targetId:        inserted!.id,
      performedBy:     session.id,
      performedByType: session.role,
      metadata:        { placement, ...updates, created: true },
    })
  }
  return NextResponse.json({ ok: true })
}
