import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionFromRequest(req)
  if (!session) return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })

  const restaurantId = params.id

  const { data: restaurant } = await supabaseAdmin
    .from('restaurants').select('id, name, customer_id, deleted_at')
    .eq('id', restaurantId).maybeSingle()

  if (!restaurant) return NextResponse.json({ error: 'Restaurant introuvable / Not found' }, { status: 404 })
  if (!restaurant.deleted_at) return NextResponse.json({ error: 'Pas supprimé / Not deleted' }, { status: 400 })

  // Check 30-day window
  const deletedAt = new Date(restaurant.deleted_at)
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
  if (deletedAt < thirtyDaysAgo && !['super_admin', 'admin'].includes(session.role)) {
    return NextResponse.json({ error: 'Délai de 30 jours dépassé / 30-day window has passed' }, { status: 400 })
  }

  if (session.role === 'customer') {
    const { data: teamEntry } = await supabaseAdmin
      .from('restaurant_team').select('role')
      .eq('restaurant_id', restaurantId).eq('customer_id', session.id).eq('status', 'active').maybeSingle()
    if (!teamEntry || teamEntry.role !== 'owner') {
      return NextResponse.json({ error: 'Non autorisé / Not authorized' }, { status: 403 })
    }
  } else if (!['super_admin', 'admin'].includes(session.role)) {
    return NextResponse.json({ error: 'Permission insuffisante / Insufficient permission' }, { status: 403 })
  }

  await supabaseAdmin.from('restaurants').update({
    deleted_at: null,
    status: 'active',
  }).eq('id', restaurantId)

  return NextResponse.json({ ok: true })
}
