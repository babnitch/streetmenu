import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'

// Server-only. Shared owner|manager gate for vendor write routes.
//
// Lives here rather than inline in each route because the menu collection
// and item routes need the identical check, and a Next.js route.ts may only
// export HTTP handlers — so it can't be shared between them directly.
//
// Resolution order, matching the open / hours / override / vouchers routes:
//   1. no session                          → 401
//   2. admin role                          → allowed
//   3. non-customer, non-admin             → 401
//   4. restaurants.customer_id === session → allowed, treated as owner.
//      "Implicit owners" are real: a restaurant can exist with customer_id
//      set and no explicit team row (see app/api/vendor/restaurants).
//   5. active restaurant_team row, owner|manager → allowed
//   6. anything else (including staff)     → 403
//
// Staff are deliberately excluded: they get read-only menu access, matching
// navConfig's minRole 'manager' on the Menu tab.
//
// Returns null when the caller is authorized, or the NextResponse to return
// when they are not.
export async function denyUnlessOwnerOrManager(
  req: NextRequest,
  restaurantId: string,
): Promise<NextResponse | null> {
  const session = getSessionFromRequest(req)
  if (!session) return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })

  if (['super_admin', 'admin', 'moderator'].includes(session.role)) return null
  if (session.role !== 'customer') {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }

  const { data: direct } = await supabaseAdmin
    .from('restaurants').select('id')
    .eq('id', restaurantId).eq('customer_id', session.id).maybeSingle()
  if (direct) return null

  const { data: team } = await supabaseAdmin
    .from('restaurant_team').select('role')
    .eq('restaurant_id', restaurantId).eq('customer_id', session.id)
    .eq('status', 'active').in('role', ['owner', 'manager']).maybeSingle()
  if (!team) {
    return NextResponse.json({ error: 'Non autorisé / Not authorized' }, { status: 403 })
  }
  return null
}
