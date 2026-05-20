import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'

export const dynamic = 'force-dynamic'

// GET /api/admin/promotions?status=all|pending_review|active|paused|completed|rejected
// Returns all promotions with promoter name + resolved target name, plus
// platform-wide revenue stats. Used by the admin Promotions tab.
export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req)
  if (!session || !['super_admin', 'admin', 'moderator'].includes(session.role)) {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }

  const url = new URL(req.url)
  const statusFilter = url.searchParams.get('status') ?? 'all'

  let q = supabaseAdmin
    .from('promotions')
    .select('id, promoter_id, target_type, target_id, placement, city, start_date, end_date, total_budget, amount_spent, impressions, clicks, payment_status, status, rejection_reason, created_at, customers(name, phone)')
    .order('created_at', { ascending: false })
    .limit(200)

  if (statusFilter !== 'all') q = q.eq('status', statusFilter)

  const { data, error } = await q
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const rows = data ?? []
  const restIds  = rows.filter(r => r.target_type === 'restaurant').map(r => r.target_id)
  const eventIds = rows.filter(r => r.target_type === 'event').map(r => r.target_id)

  const [restMap, eventMap, revenueAgg] = await Promise.all([
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
    supabaseAdmin
      .from('promotions').select('total_budget').eq('payment_status', 'paid')
      .then(({ data }) => (data ?? []).reduce((s, r) => s + (r.total_budget ?? 0), 0)),
  ])

  return NextResponse.json({
    promotions: rows.map(r => ({
      ...r,
      target_name: r.target_type === 'restaurant'
        ? (restMap[r.target_id] ?? '—')
        : (eventMap[r.target_id] ?? '—'),
    })),
    revenue_total: revenueAgg,
  })
}
