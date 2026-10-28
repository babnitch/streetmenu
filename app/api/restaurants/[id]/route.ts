import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'
import { validatePrepTime } from '@/lib/prepTime'
import { validateDeliverySettings } from '@/lib/delivery'
import { validateMenuType } from '@/lib/menuDays'
import { requireRestaurantModule } from '@/lib/modulesServer'

export const dynamic = 'force-dynamic'

// PATCH /api/restaurants/[id]
// Body: { prep_time_min, prep_time_max }
//    or { delivery_enabled, delivery_fee, delivery_extra_min }   (V1)
//    or { menu_type: 'a_la_carte' | 'daily' }                    (Menu par jour)
//
// Owner + manager (+ admin) can set the kitchen's estimated preparation
// range — it's an operational setting like opening hours, not a commercial
// one like payment, so managers are allowed. POST is accepted too because
// the rest of the vendor API tree uses POST for owner-side mutations and
// the WhatsApp/dashboard clients are inconsistent about the verb.
async function update(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionFromRequest(req)
  if (!session) return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })

  const isAdmin = ['super_admin', 'admin', 'moderator'].includes(session.role)
  if (!isAdmin) {
    if (session.role !== 'customer') {
      return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
    }
    // Direct ownership OR an active owner/manager team row.
    const { data: r } = await supabaseAdmin
      .from('restaurants').select('id').eq('id', params.id).eq('customer_id', session.id).maybeSingle()
    if (!r) {
      const { data: team } = await supabaseAdmin
        .from('restaurant_team').select('role')
        .eq('restaurant_id', params.id).eq('customer_id', session.id)
        .eq('status', 'active').in('role', ['owner', 'manager']).maybeSingle()
      if (!team) return NextResponse.json({ error: 'Non autorisé / Not authorized' }, { status: 403 })
    }
  }

  let body: {
    prep_time_min?: unknown; prep_time_max?: unknown
    delivery_enabled?: unknown; delivery_fee?: unknown; delivery_extra_min?: unknown
    menu_type?: unknown
  }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'invalid json' }, { status: 400 }) }

  const hasPrep     = body.prep_time_min !== undefined || body.prep_time_max !== undefined
  const hasDelivery = body.delivery_enabled !== undefined || body.delivery_fee !== undefined || body.delivery_extra_min !== undefined
  const hasMenuType = body.menu_type !== undefined
  if (!hasPrep && !hasDelivery && !hasMenuType) {
    return NextResponse.json({ error: 'Aucune modification / No changes' }, { status: 400 })
  }

  const updates: Record<string, unknown> = {}
  if (hasPrep) {
    const v = validatePrepTime(body.prep_time_min, body.prep_time_max)
    if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 })
    updates.prep_time_min = v.min
    updates.prep_time_max = v.max
  }
  if (hasDelivery) {
    const d = validateDeliverySettings(body)
    if (!d.ok) return NextResponse.json({ error: d.error }, { status: 400 })
    // M2: delivering needs the Livraison module (switching it off is allowed).
    if (d.settings.delivery_enabled) {
      const off = await requireRestaurantModule(params.id, 'delivery')
      if (off) return off
    }
    Object.assign(updates, d.settings)
  }

  if (hasMenuType) {
    const mt = validateMenuType(body.menu_type)
    if (!mt) return NextResponse.json({ error: 'Type de menu invalide / Invalid menu type' }, { status: 400 })
    updates.menu_type = mt
  }

  const { data: before } = await supabaseAdmin
    .from('restaurants')
    .select('prep_time_min, prep_time_max, delivery_enabled, delivery_fee, delivery_extra_min, menu_type')
    .eq('id', params.id)
    .maybeSingle()
  if (!before) return NextResponse.json({ error: 'Restaurant introuvable / not found' }, { status: 404 })

  const { error } = await supabaseAdmin
    .from('restaurants')
    .update(updates)
    .eq('id', params.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const previous = Object.fromEntries(Object.keys(updates).map(k => [k, (before as Record<string, unknown>)[k]]))
  await writeAudit({
    action:          hasMenuType && !hasPrep && !hasDelivery ? 'menu_type_updated'
                   : hasDelivery && !hasPrep ? 'delivery_settings_updated' : 'prep_time_updated',
    targetType:      'restaurant',
    targetId:        params.id,
    performedBy:     session.id,
    performedByType: isAdmin ? session.role : 'vendor',
    previousData:    previous,
    metadata:        updates,
  })

  return NextResponse.json({ ok: true, ...updates })
}

export const PATCH = update
export const POST  = update
