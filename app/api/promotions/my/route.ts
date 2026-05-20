import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'

export const dynamic = 'force-dynamic'

// GET /api/promotions/my
// Returns the caller's promotions, most recent first, with the resolved
// target name joined client-side via two follow-up lookups. Restaurants
// and events live in different tables so we batch them per type.
export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req)
  if (!session || session.role !== 'customer') {
    return NextResponse.json({ promotions: [] })
  }

  const { data, error } = await supabaseAdmin
    .from('promotions')
    .select('id, target_type, target_id, placement, city, start_date, end_date, total_budget, amount_spent, impressions, clicks, payment_status, status, created_at')
    .eq('promoter_id', session.id)
    .order('created_at', { ascending: false })
    .limit(50)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const rows = data ?? []
  const restIds  = rows.filter(r => r.target_type === 'restaurant').map(r => r.target_id)
  const eventIds = rows.filter(r => r.target_type === 'event').map(r => r.target_id)

  const [restMap, eventMap] = await Promise.all([
    restIds.length === 0
      ? Promise.resolve({} as Record<string, string>)
      : supabaseAdmin
          .from('restaurants').select('id, name').in('id', restIds)
          .then(({ data }) => Object.fromEntries((data ?? []).map(r => [r.id, r.name]))),
    eventIds.length === 0
      ? Promise.resolve({} as Record<string, string>)
      : supabaseAdmin
          .from('events').select('id, title').in('id', eventIds)
          .then(({ data }) => Object.fromEntries((data ?? []).map(e => [e.id, e.title]))),
  ])

  return NextResponse.json({
    promotions: rows.map(r => ({
      ...r,
      target_name: r.target_type === 'restaurant'
        ? (restMap[r.target_id] ?? '—')
        : (eventMap[r.target_id] ?? '—'),
    })),
  })
}
