import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'

export const dynamic = 'force-dynamic'

// GET: all restaurants the current customer is on the team for
export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req)
  if (!session || session.role !== 'customer') {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }

  const { data: entries } = await supabaseAdmin
    .from('restaurant_team')
    .select('role, restaurants(id, name, city, neighborhood, cuisine_type, image_url, is_active, status, deleted_at, suspended_at, suspended_by, whatsapp, customer_id)')
    .eq('customer_id', session.id)
    .eq('status', 'active')

  const restaurants = (entries ?? []).map(e => ({
    ...(e.restaurants as unknown as Record<string, unknown>),
    teamRole: e.role,
  }))

  return NextResponse.json({ restaurants })
}
