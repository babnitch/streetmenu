import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req)
  if (!session || !['super_admin', 'admin'].includes(session.role)) {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }

  const [
    { data: customers },
    { data: teamEntries },
    { data: restaurants },
  ] = await Promise.all([
    supabaseAdmin
      .from('customers')
      .select('id, name, phone, city, status, suspended_at, suspended_by, suspension_reason, deleted_at, created_at')
      .order('created_at', { ascending: false })
      .limit(500),
    supabaseAdmin
      .from('restaurant_team')
      .select('customer_id, role')
      .eq('status', 'active'),
    supabaseAdmin
      .from('restaurants')
      .select('id, customer_id')
      .not('customer_id', 'is', null),
  ])

  // Build role map per customer
  const rolesByCustomer: Record<string, Set<string>> = {}
  for (const t of teamEntries ?? []) {
    if (!rolesByCustomer[t.customer_id]) rolesByCustomer[t.customer_id] = new Set()
    rolesByCustomer[t.customer_id].add(t.role)
  }

  // Build restaurant count per customer
  const restCountByCustomer: Record<string, number> = {}
  for (const r of restaurants ?? []) {
    if (r.customer_id) {
      restCountByCustomer[r.customer_id] = (restCountByCustomer[r.customer_id] ?? 0) + 1
    }
  }

  const accounts = (customers ?? []).map(c => ({
    ...c,
    restaurant_count: restCountByCustomer[c.id] ?? 0,
    roles: Array.from(rolesByCustomer[c.id] ?? []),
  }))

  return NextResponse.json({ accounts })
}
