// Server-only: is this session an admin, the restaurant's implicit owner
// (restaurants.customer_id), or an active member (any role) of its team?
// Used by the order list and the protected-payment code entry.

import { supabaseAdmin } from '@/lib/supabaseAdmin'

export const ADMIN_ROLES = ['super_admin', 'admin', 'moderator']

export async function isTeamOrAdmin(session: { id: string; role: string }, restaurantId: string): Promise<boolean> {
  if (ADMIN_ROLES.includes(session.role)) return true
  if (session.role !== 'customer') return false
  const { count: owner } = await supabaseAdmin.from('restaurants').select('id', { count: 'exact', head: true })
    .eq('id', restaurantId).eq('customer_id', session.id)
  if ((owner ?? 0) > 0) return true
  const { count } = await supabaseAdmin.from('restaurant_team').select('id', { count: 'exact', head: true })
    .eq('restaurant_id', restaurantId).eq('customer_id', session.id).eq('status', 'active')
  return (count ?? 0) > 0
}
