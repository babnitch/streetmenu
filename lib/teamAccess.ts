// Server-only: is this session an active member (any role) of the
// restaurant's team, or an admin? Used by the protected-payment code entry.

import { supabaseAdmin } from '@/lib/supabaseAdmin'

export const ADMIN_ROLES = ['super_admin', 'admin', 'moderator']

export async function isTeamOrAdmin(session: { id: string; role: string }, restaurantId: string): Promise<boolean> {
  if (ADMIN_ROLES.includes(session.role)) return true
  const { count } = await supabaseAdmin.from('restaurant_team').select('id', { count: 'exact', head: true })
    .eq('restaurant_id', restaurantId).eq('customer_id', session.id).eq('status', 'active')
  return (count ?? 0) > 0
}
