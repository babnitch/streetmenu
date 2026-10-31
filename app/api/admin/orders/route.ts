import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { adminCanFor } from '@/lib/adminNav'

export const dynamic = 'force-dynamic'

const DAY = /^\d{4}-\d{2}-\d{2}$/
const UUID = /^[0-9a-f-]{36}$/i

// GET /api/admin/orders — Admin → Commandes. Orders are server-only (the
// page used to read them with the public key). Filters: restaurant, status,
// payment (paid | pending | failed | reservation), from / to (YYYY-MM-DD).
// ?only=restaurants returns the restaurant filter list. Admin roles that can see
// the Orders tab (moderators included).
export async function GET(req: NextRequest) {
  const s = getSessionFromRequest(req)
  if (!s || !adminCanFor(s.role, 'orders')) return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  const p = req.nextUrl.searchParams
  const restaurant = p.get('restaurant') ?? ''
  const status = p.get('status') ?? ''
  const payment = p.get('payment') ?? ''
  const from = p.get('from') ?? ''
  const to = p.get('to') ?? ''

  // ?only=restaurants: just the restaurant list for the filter.
  if (p.get('only') === 'restaurants') {
    const { data, error } = await supabaseAdmin.from('restaurants').select('id, name, city').order('name')
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ restaurants: data ?? [] }, { headers: { 'Cache-Control': 'no-store' } })
  }

  let q = supabaseAdmin.from('orders').select('*, restaurants(name, city)').order('created_at', { ascending: false }).limit(1000)
  if (UUID.test(restaurant)) q = q.eq('restaurant_id', restaurant)
  if (status && status !== 'all') q = q.eq('status', status)
  if (payment === 'paid' || payment === 'pending' || payment === 'failed') q = q.eq('payment_status', payment)
  else if (payment === 'reservation') q = q.eq('order_type', 'reservation')
  if (DAY.test(from)) q = q.gte('created_at', from + 'T00:00:00')
  if (DAY.test(to)) q = q.lte('created_at', to + 'T23:59:59')

  const orders = await q
  if (orders.error) return NextResponse.json({ error: orders.error.message }, { status: 500 })
  return NextResponse.json({ orders: orders.data ?? [] }, { headers: { 'Cache-Control': 'no-store' } })
}
