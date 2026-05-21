import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'

export const dynamic = 'force-dynamic'

// GET /api/customer/orders
// Returns the logged-in customer's recent orders, joined with the
// restaurant's name + city for the /account Orders tab. Empty array
// for non-customers so the same fetch can be used on every page load
// without a session check on the client.
//
// Replaces the previous direct supabase.from('orders') reads in
// app/account/page.tsx, which only worked because RLS used to be
// open. After supabase-rls-policies.sql locks `orders` to service-
// role only, this endpoint is the way customers get their own list.
export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req)
  if (!session || session.role !== 'customer') {
    return NextResponse.json({ orders: [] })
  }

  const { data, error } = await supabaseAdmin
    .from('orders')
    .select('*, restaurants(name, city)')
    .eq('customer_id', session.id)
    .order('created_at', { ascending: false })
    .limit(20)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ orders: data ?? [] })
}
