import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { todayInDouala } from '@/lib/weekend'
import { PERIODS, periodStart, restaurantFigures, sumStats, type Period, type OrderRow } from '@/lib/overview'

export const dynamic = 'force-dynamic'

// GET /api/restaurants/[id]/overview?period=today|7d|30d — the dashboard's
// "Aperçu": orders, revenue (online / sur place), average, cancelled,
// delivery vs take-away, top 5 dishes, busiest hours (Africa/Douala), page
// views and clicks (anonymous daily counts). Owner + manager (and admins).
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const s = getSessionFromRequest(req)
  if (!s) return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  const isAdmin = ['super_admin', 'admin', 'moderator'].includes(s.role)
  if (!isAdmin) {
    if (s.role !== 'customer') return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
    const { data: own } = await supabaseAdmin.from('restaurants').select('id').eq('id', params.id).eq('customer_id', s.id).maybeSingle()
    if (!own) {
      const { data: team } = await supabaseAdmin.from('restaurant_team').select('role')
        .eq('restaurant_id', params.id).eq('customer_id', s.id).eq('status', 'active').in('role', ['owner', 'manager']).maybeSingle()
      if (!team) return NextResponse.json({ error: 'Réservé au propriétaire et au gérant / Owner and manager only' }, { status: 403 })
    }
  }
  const period = (req.nextUrl.searchParams.get('period') ?? 'today') as Period
  if (!PERIODS.includes(period)) return NextResponse.json({ error: 'period' }, { status: 400 })
  const today = todayInDouala()
  const start = periodStart(period, today)

  const [ordersRes, statsRes] = await Promise.all([
    supabaseAdmin.from('orders').select('created_at, status, payment_status, total_price, refunded_amount, fulfilment, items')
      .eq('restaurant_id', params.id).gte('created_at', start.iso).range(0, 9999),
    supabaseAdmin.from('stats_daily').select('metric, count').eq('item_type', 'restaurant').eq('item_id', params.id).gte('day', start.day),
  ])
  if (ordersRes.error) return NextResponse.json({ error: ordersRes.error.message }, { status: 500 })
  return NextResponse.json({
    period, from: start.day, to: today,
    ...restaurantFigures((ordersRes.data ?? []) as OrderRow[]),
    ...sumStats((statsRes.data ?? []) as Array<{ metric: string; count: number }>),
  }, { headers: { 'Cache-Control': 'no-store' } })
}
