import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'

export const dynamic = 'force-dynamic'
export const revalidate = 0

// GET — admin list of every customer (ALL statuses: active, suspended, deleted)
// Uses the service-role client so RLS on the customers table cannot filter rows.
export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req)
  if (!session || !['super_admin', 'admin'].includes(session.role)) {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }

  // .range() sidesteps whatever default row limit PostgREST might apply.
  // No filter, no status check — the admin needs every row.
  const [customersRes, teamRes, restRes, countRes, auditRes] = await Promise.all([
    supabaseAdmin
      .from('customers')
      .select('id, name, phone, city, status, suspended_at, suspended_by, suspension_reason, deleted_at, created_at')
      .order('created_at', { ascending: false })
      .range(0, 9999),
    supabaseAdmin
      .from('restaurant_team')
      .select('customer_id, role')
      .eq('status', 'active')
      .range(0, 9999),
    supabaseAdmin
      .from('restaurants')
      .select('id, customer_id')
      .not('customer_id', 'is', null)
      .range(0, 9999),
    supabaseAdmin
      .from('customers')
      .select('id', { count: 'exact', head: true }),
    // History of released numbers — used to surface "Numéro réutilisé"
    // when a current customer's phone was previously released.
    supabaseAdmin
      .from('audit_log')
      .select('id, previous_data, created_at')
      .eq('action', 'number_released')
      .order('created_at', { ascending: false })
      .range(0, 9999),
  ])

  // Surface errors clearly — previously a silent .data = null meant an empty list.
  if (customersRes.error) {
    console.error('[admin/accounts] customers query error:', customersRes.error)
    return NextResponse.json(
      { error: customersRes.error.message, accounts: [], totalInDb: null },
      { status: 500 }
    )
  }
  if (teamRes.error)  console.error('[admin/accounts] restaurant_team query error:', teamRes.error)
  if (restRes.error)  console.error('[admin/accounts] restaurants query error:', restRes.error)
  if (countRes.error) console.error('[admin/accounts] count query error:', countRes.error)

  const customers   = customersRes.data ?? []
  const teamEntries = teamRes.data ?? []
  const restaurants = restRes.data ?? []

  const rolesByCustomer: Record<string, Set<string>> = {}
  for (const t of teamEntries) {
    if (!rolesByCustomer[t.customer_id]) rolesByCustomer[t.customer_id] = new Set()
    rolesByCustomer[t.customer_id].add(t.role)
  }

  const restCountByCustomer: Record<string, number> = {}
  for (const r of restaurants) {
    if (r.customer_id) {
      restCountByCustomer[r.customer_id] = (restCountByCustomer[r.customer_id] ?? 0) + 1
    }
  }

  // Build phone → most-recent 'number_released' audit entry. A customer
  // whose current phone matches any historical previous_data.customer.phone
  // inherited that number.
  type ReleasedAudit = {
    id: string
    created_at: string
    previous_data: {
      customer?: { name?: string; phone?: string; city?: string; created_at?: string }
      restaurants?: Array<{ id: string; name: string; city?: string; whatsapp?: string; status?: string }>
    } | null
  }
  const releasedByPhone: Record<string, ReleasedAudit> = {}
  for (const row of (auditRes.data ?? []) as ReleasedAudit[]) {
    const phone = row.previous_data?.customer?.phone
    if (!phone) continue
    // audit rows are ordered desc — keep first seen (most recent) per phone.
    if (!releasedByPhone[phone]) releasedByPhone[phone] = row
  }

  const accounts = customers.map(c => {
    const reused = c.phone ? releasedByPhone[c.phone] : undefined
    return {
      ...c,
      restaurant_count: restCountByCustomer[c.id] ?? 0,
      roles: Array.from(rolesByCustomer[c.id] ?? []),
      reusedFrom: reused
        ? {
            audit_id:      reused.id,
            released_at:   reused.created_at,
            previous_name: reused.previous_data?.customer?.name ?? null,
            previous_city: reused.previous_data?.customer?.city ?? null,
            previous_signup: reused.previous_data?.customer?.created_at ?? null,
            restaurants:   reused.previous_data?.restaurants ?? [],
          }
        : null,
    }
  })

  // Diagnostic: if this differs from accounts.length, RLS or an env var is
  // filtering us — the client can surface the mismatch in the UI.
  const totalInDb = countRes.count ?? null

  return NextResponse.json({ accounts, totalInDb })
}
