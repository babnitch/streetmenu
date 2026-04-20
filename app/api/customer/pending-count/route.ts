import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'

export const dynamic = 'force-dynamic'

// GET /api/customer/pending-count → { count }
// Companion to /api/vendor/pending-count: instead of counting non-terminal
// orders across restaurants the session operates, this counts non-terminal
// orders that belong to the session as a *customer*. Drives the red badge
// on the 📦 icon in the client-mode BottomNav. Returns 0 for logged-out
// sessions, admins, and any error so the badge simply stays hidden.
export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req)
  if (!session || session.role !== 'customer') {
    return NextResponse.json({ count: 0 })
  }

  const { count } = await supabaseAdmin
    .from('orders')
    .select('id', { count: 'exact', head: true })
    .eq('customer_id', session.id)
    .in('status', ['pending', 'confirmed', 'preparing', 'ready'])

  return NextResponse.json({ count: count ?? 0 })
}
