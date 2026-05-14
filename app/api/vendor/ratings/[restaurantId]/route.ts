import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { aggregate } from '@/lib/ratings'

export const dynamic = 'force-dynamic'

// GET /api/vendor/ratings/[restaurantId]
// Restaurant aggregate for the vendor dashboard. Authorized when the
// caller owns the restaurant directly (restaurants.customer_id) or is
// an active owner/manager/staff via restaurant_team. Admins bypass.
//
// Returns aggregate + a 30-day trend marker (up / down / flat) so the
// vendor sees motion without a chart library.
export async function GET(req: NextRequest, { params }: { params: { restaurantId: string } }) {
  const session = getSessionFromRequest(req)
  if (!session) return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })

  const isAdmin = ['super_admin', 'admin', 'moderator'].includes(session.role)

  if (!isAdmin) {
    // Direct ownership shortcut.
    const { data: direct } = await supabaseAdmin
      .from('restaurants').select('id').eq('id', params.restaurantId).eq('customer_id', session.id).maybeSingle()
    if (!direct) {
      // Team-based access. Owner/manager/staff can all see ratings — it's
      // aggregate data, not PII.
      const { data: team } = await supabaseAdmin
        .from('restaurant_team').select('role')
        .eq('restaurant_id', params.restaurantId).eq('customer_id', session.id)
        .eq('status', 'active').in('role', ['owner', 'manager', 'staff'])
        .maybeSingle()
      if (!team) return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 403 })
    }
  }

  const { data: all } = await supabaseAdmin
    .from('restaurant_ratings')
    .select('rating, tags, created_at')
    .eq('restaurant_id', params.restaurantId)

  const rows = all ?? []
  const agg = aggregate(rows)

  // Trend: compare avg of last 30 days vs the 30 days before that.
  // Falls back to 'flat' when either window has < 3 rows.
  const now = Date.now()
  const day = 24 * 60 * 60 * 1000
  const cutoffRecent = now - 30 * day
  const cutoffPrior  = now - 60 * day
  const recent = rows.filter(r => new Date(r.created_at).getTime() >= cutoffRecent)
  const prior  = rows.filter(r => {
    const t = new Date(r.created_at).getTime()
    return t >= cutoffPrior && t < cutoffRecent
  })
  let trend: 'up' | 'down' | 'flat' = 'flat'
  if (recent.length >= 3 && prior.length >= 3) {
    const avgR = recent.reduce((s, r) => s + r.rating, 0) / recent.length
    const avgP = prior.reduce((s, r) => s + r.rating, 0) / prior.length
    if      (avgR - avgP >= 0.2) trend = 'up'
    else if (avgP - avgR >= 0.2) trend = 'down'
  }

  return NextResponse.json({ ...agg, trend, recent_count: recent.length })
}
