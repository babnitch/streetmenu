import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'
import { sanitizeTags } from '@/lib/ratings'

export const dynamic = 'force-dynamic'

// POST /api/restaurants/[id]/rate
// Body: { rating: 1-5, tags?: string[], orderId?: string }
//
// Only customers with a *delivered* order at this restaurant can rate.
// If orderId is omitted, the most-recent delivered order is used. Repeat
// submissions for the same (restaurant, customer, order) overwrite the
// existing row (UNIQUE constraint enforces one per order).
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionFromRequest(req)
  if (!session || session.role !== 'customer') {
    return NextResponse.json({ error: 'Connexion requise / Login required' }, { status: 401 })
  }

  const body = await req.json().catch(() => ({}))
  const rating = Number(body?.rating)
  if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
    return NextResponse.json({ error: 'Note invalide / Invalid rating' }, { status: 400 })
  }
  const tags = sanitizeTags(body?.tags)

  // Find the order to anchor this rating against. Spec: must be delivered.
  // If client passes an explicit orderId, validate it belongs to this
  // customer + restaurant + is delivered; otherwise pick the most recent.
  const explicitOrderId = typeof body?.orderId === 'string' ? body.orderId : null

  let orderRow: { id: string } | null = null
  if (explicitOrderId) {
    const { data } = await supabaseAdmin
      .from('orders')
      .select('id, status, restaurant_id, customer_id')
      .eq('id', explicitOrderId).maybeSingle()
    if (!data) return NextResponse.json({ error: 'Commande introuvable / Order not found' }, { status: 404 })
    if (data.customer_id !== session.id || data.restaurant_id !== params.id) {
      return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 403 })
    }
    if (!['delivered', 'completed'].includes(data.status)) {
      return NextResponse.json({ error: 'Cette commande n\'a pas encore été livrée / Order not delivered yet' }, { status: 409 })
    }
    orderRow = { id: data.id }
  } else {
    const { data } = await supabaseAdmin
      .from('orders')
      .select('id')
      .eq('customer_id', session.id)
      .eq('restaurant_id', params.id)
      .in('status', ['delivered', 'completed'])
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (!data) {
      return NextResponse.json({
        error: 'Commandez d\'abord pour pouvoir noter / Order first to rate',
      }, { status: 403 })
    }
    orderRow = data
  }

  // Upsert by the UNIQUE constraint. Capture the prior row so we know
  // whether to audit as created vs updated.
  const { data: existing } = await supabaseAdmin
    .from('restaurant_ratings')
    .select('id, rating, tags')
    .eq('restaurant_id', params.id)
    .eq('customer_id',   session.id)
    .eq('order_id',      orderRow.id)
    .maybeSingle()

  let resultId = ''
  if (existing) {
    const { data, error } = await supabaseAdmin
      .from('restaurant_ratings')
      .update({ rating, tags, updated_at: new Date().toISOString() })
      .eq('id', existing.id)
      .select('id').single()
    if (error || !data) return NextResponse.json({ error: error?.message ?? 'Erreur / Error' }, { status: 500 })
    resultId = data.id
  } else {
    const { data, error } = await supabaseAdmin
      .from('restaurant_ratings')
      .insert({
        restaurant_id: params.id,
        customer_id:   session.id,
        order_id:      orderRow.id,
        rating, tags,
      })
      .select('id').single()
    if (error || !data) return NextResponse.json({ error: error?.message ?? 'Erreur / Error' }, { status: 500 })
    resultId = data.id
  }

  await writeAudit({
    action:          existing ? 'rating_updated' : 'rating_created',
    targetType:      'restaurant',
    targetId:        params.id,
    performedBy:     session.id,
    performedByType: 'customer',
    previousData:    existing ? { rating: existing.rating, tags: existing.tags } : null,
    metadata:        { rating_id: resultId, rating, tags, order_id: orderRow.id },
  })

  return NextResponse.json({ ok: true, rating_id: resultId, updated: !!existing })
}
