import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { aggregate } from '@/lib/ratings'

export const dynamic = 'force-dynamic'

// GET /api/restaurants/[id]/rating
// Public aggregate — no individual ratings exposed. When a customer is
// logged in we also return:
//   - their_rating: the existing rating row for their most-recent delivered
//     order (so the modal can pre-fill).
//   - can_rate: true when they have at least one delivered order without a
//     rating yet — drives the "Rate this restaurant" CTA.
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const { data: rows } = await supabaseAdmin
    .from('restaurant_ratings')
    .select('rating, tags')
    .eq('restaurant_id', params.id)

  const agg = aggregate(rows ?? [])

  const session = getSessionFromRequest(req)
  let theirRating: { rating: number; tags: string[]; order_id: string } | null = null
  let canRate = false
  if (session?.role === 'customer') {
    const { data: lastOrder } = await supabaseAdmin
      .from('orders')
      .select('id')
      .eq('customer_id', session.id)
      .eq('restaurant_id', params.id)
      .in('status', ['delivered', 'completed'])
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (lastOrder) {
      canRate = true
      const { data: prior } = await supabaseAdmin
        .from('restaurant_ratings')
        .select('rating, tags, order_id')
        .eq('restaurant_id', params.id)
        .eq('customer_id',   session.id)
        .eq('order_id',      lastOrder.id)
        .maybeSingle()
      if (prior) {
        theirRating = {
          rating:  prior.rating,
          tags:    Array.isArray(prior.tags) ? prior.tags : [],
          order_id: prior.order_id,
        }
      }
    }
  }

  return NextResponse.json({ ...agg, can_rate: canRate, their_rating: theirRating })
}
