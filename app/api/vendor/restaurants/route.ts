import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { Restaurant } from '@/types'

export const dynamic = 'force-dynamic'

// GET: every restaurant the current customer is a vendor of.
//
// Two sources are merged:
//   1. restaurant_team rows with status='active' — covers owners, managers,
//      and staff explicitly invited to the team.
//   2. restaurants.customer_id === session.id — covers legacy rows created
//      before the team-row trigger existed, and any future gap where the
//      trigger didn't fire. Treated as implicit 'owner' so the vendor
//      dashboard and status-update route don't 403 the true owner.
//
// Deduped by restaurant.id. When a restaurant appears in both sources,
// the explicit restaurant_team row wins (respects an intentional downgrade
// even if the direct customer_id link still points at this user).
export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req)
  if (!session || session.role !== 'customer') {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }

  // Select every column: the vendor dashboard renders `is_open`,
  // `address`, `logo_url`, etc., and an explicit allow-list kept
  // dropping fields (is_open was missing, which made "Closed" stick
  // even when the DB said open). These rows are only ever returned
  // to their own owner/team, so there is nothing to hide.
  const [teamRes, directRes] = await Promise.all([
    supabaseAdmin
      .from('restaurant_team')
      .select('role, restaurants(*)')
      .eq('customer_id', session.id)
      .eq('status', 'active'),
    supabaseAdmin
      .from('restaurants')
      .select('*')
      .eq('customer_id', session.id)
      .is('deleted_at', null)
      .neq('status', 'deleted'),
  ])

  type RestaurantRow = Restaurant & { customer_id: string | null }

  const merged = new Map<string, RestaurantRow & { teamRole: 'owner' | 'manager' | 'staff' }>()

  for (const entry of teamRes.data ?? []) {
    const r = entry.restaurants as unknown as RestaurantRow | null
    if (!r) continue
    // Skip deleted restaurants even when the team row still points at them.
    if (r.deleted_at || r.status === 'deleted') continue
    const role = entry.role as 'owner' | 'manager' | 'staff'
    merged.set(r.id, { ...r, teamRole: role })
  }
  for (const r of directRes.data ?? []) {
    if (merged.has(r.id)) continue // explicit team row wins
    merged.set(r.id, { ...r, teamRole: 'owner' })
  }

  const restaurants = Array.from(merged.values())
  const rolesByRestaurantId: Record<string, 'owner' | 'manager' | 'staff'> = {}
  for (const r of restaurants) rolesByRestaurantId[r.id] = r.teamRole

  return NextResponse.json({ restaurants, rolesByRestaurantId })
}
