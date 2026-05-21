import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'

export const dynamic = 'force-dynamic'

// GET /api/customer/vouchers/my
// Returns the caller's claimed vouchers with the joined voucher row
// (and the restaurant name when the voucher is restaurant-scoped) for
// the /account Vouchers tab and the /order voucher picker. Empty array
// for non-customers so the route is safe to call without auth checks
// on the client side.
//
// Replaces direct supabase.from('customer_vouchers') reads on
// app/account/page.tsx and app/order/page.tsx — necessary now that
// the customer_vouchers RLS is locked to service-role-only.
export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req)
  if (!session || session.role !== 'customer') {
    return NextResponse.json({ vouchers: [] })
  }

  const { data, error } = await supabaseAdmin
    .from('customer_vouchers')
    .select('*, vouchers(*, restaurants(name))')
    .eq('customer_id', session.id)
    .order('claimed_at', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ vouchers: data ?? [] })
}
