import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'

export const dynamic = 'force-dynamic'

// GET /api/admin/broadcasts/stats
// Subscriber counts per city + category breakdown for the active list.
// Used by the admin Broadcasts subtab to surface the audience size before
// the admin tweaks pricing.
export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req)
  if (!session || !['super_admin', 'admin', 'moderator'].includes(session.role)) {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }

  const { data, error } = await supabaseAdmin
    .from('event_subscriptions')
    .select('city, categories, is_active')
    .eq('is_active', true)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const byCity: Record<string, { total: number; categories: Record<string, number> }> = {}
  for (const s of data ?? []) {
    const c = s.city as string
    byCity[c] ??= { total: 0, categories: {} }
    byCity[c].total += 1
    const cats = (s.categories as string[] | null) ?? ['ALL']
    for (const cat of cats) {
      byCity[c].categories[cat] = (byCity[c].categories[cat] ?? 0) + 1
    }
  }
  return NextResponse.json({ by_city: byCity, total_active: (data ?? []).length })
}
