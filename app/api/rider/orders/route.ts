import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { riderRowsOf, cashToCollect, OPEN_FOR_RIDER } from '@/lib/riders'
import { orderCode } from '@/lib/shortCode'

export const dynamic = 'force-dynamic'

// GET /api/rider/orders (Q5) — "Mes livraisons": ONLY the orders assigned to
// the logged-in rider (open ones, and those delivered today). Nothing else.
export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req)
  if (!session || session.role !== 'customer') return NextResponse.json({ error: 'Connexion requise / Login required' }, { status: 401 })
  const rows = await riderRowsOf(session.id)
  if (rows.length === 0) return NextResponse.json({ rider: false, orders: [] })
  const since = new Date(Date.now() - 24 * 3_600_000).toISOString()
  const { data } = await supabaseAdmin.from('orders')
    .select('id, restaurant_id, status, customer_name, customer_phone, items, total_price, delivery_address, delivery_landmark, delivery_phone, order_type, payment_status, delivered_at, created_at')
    .in('rider_id', rows.map(r => r.id))
    .or(`status.in.(${OPEN_FOR_RIDER.join(',')}),delivered_at.gte.${since}`)
    .order('created_at', { ascending: false }).limit(50)
  const restIds = Array.from(new Set(((data ?? []) as Array<{ restaurant_id: string }>).map(o => o.restaurant_id)))
  const { data: rests } = restIds.length ? await supabaseAdmin.from('restaurants').select('id, name').in('id', restIds) : { data: [] }
  const names = Object.fromEntries(((rests ?? []) as Array<{ id: string; name: string }>).map(r => [r.id, r.name]))
  const orders = ((data ?? []) as Array<Record<string, unknown> & { id: string; restaurant_id: string; order_type: string | null; payment_status: string | null; total_price: number }>)
    .map(o => ({
      id: o.id, number: orderCode(o.id), restaurant: names[o.restaurant_id] ?? '', status: o.status,
      customer_name: o.customer_name, phone: o.delivery_phone || o.customer_phone, address: o.delivery_address,
      landmark: o.delivery_landmark, items: o.items, cash: cashToCollect(o), delivered_at: o.delivered_at,
    }))
  return NextResponse.json({ rider: true, orders }, { headers: { 'Cache-Control': 'no-store' } })
}
