import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'

export const dynamic = 'force-dynamic'

// GET /api/vendor/pending-count → { count }
// Lightweight poll endpoint used by BottomNav. Returns the number of
// non-terminal orders (pending / confirmed / preparing / ready) across
// every restaurant the session owns directly OR via restaurant_team
// (owner / manager / staff, status = active). Zero for non-customers,
// non-vendors, and admins — they still get 200 with count:0 so the UI
// doesn't need to special-case.
export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req)
  if (!session || session.role !== 'customer') {
    return NextResponse.json({ count: 0 })
  }

  const [direct, team] = await Promise.all([
    supabaseAdmin.from('restaurants').select('id')
      .eq('customer_id', session.id)
      .is('deleted_at', null).neq('status', 'deleted'),
    supabaseAdmin.from('restaurant_team')
      .select('restaurants(id, deleted_at, status)')
      .eq('customer_id', session.id).eq('status', 'active'),
  ])

  const ids = new Set<string>()
  for (const r of direct.data ?? []) ids.add(r.id)
  for (const entry of team.data ?? []) {
    const r = entry.restaurants as unknown as { id: string; deleted_at: string | null; status: string } | null
    if (!r || r.deleted_at || r.status === 'deleted') continue
    ids.add(r.id)
  }
  if (ids.size === 0) return NextResponse.json({ count: 0 })

  // Non-terminal = vendor has work to do. Terminal states (delivered /
  // completed / cancelled) don't count toward the badge.
  const { count } = await supabaseAdmin
    .from('orders')
    .select('id', { count: 'exact', head: true })
    .in('restaurant_id', Array.from(ids))
    .in('status', ['pending', 'confirmed', 'preparing', 'ready'])

  return NextResponse.json({ count: count ?? 0 })
}
