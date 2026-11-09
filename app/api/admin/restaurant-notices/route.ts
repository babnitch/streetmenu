import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'

export const dynamic = 'force-dynamic'

// GET /api/admin/restaurant-notices — « Modifié par le propriétaire »: owner
// changes to name, address, pin, city, area or phones (live already, no new
// approval), not yet marked « Vu ». Newest first, with the restaurant's name.
// super_admin | admin | moderator.
export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req)
  if (!session || !['super_admin', 'admin', 'moderator'].includes(session.role)) {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }
  const { data, error } = await supabaseAdmin.from('restaurant_change_notices')
    .select('id, restaurant_id, changes, created_at, restaurants(name, city)')
    .is('seen_at', null).is('deleted_at', null)
    .order('created_at', { ascending: false }).range(0, 199)
  if (error) {
    console.error('[admin/restaurant-notices] query failed:', error.message)
    return NextResponse.json({ notices: [] })
  }
  return NextResponse.json({ notices: data ?? [] })
}
