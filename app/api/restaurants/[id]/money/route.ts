import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { denyUnlessOwnerOrManager } from '@/lib/vendorAccess'
import { restaurantBalances } from '@/lib/proPayouts'
import { isSandboxMoney } from '@/lib/protectedPayments'

export const dynamic = 'force-dynamic'

// GET /api/restaurants/[id]/money — "Mon argent" (protected payments):
// held, available, in transit, paid out; the payout number; recent
// payouts. Owner + manager (and admins).
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = await denyUnlessOwnerOrManager(req, params.id)
  if (denied) return denied
  const { data: r } = await supabaseAdmin.from('restaurants').select('whatsapp, payout_phone, payout_phone_pending').eq('id', params.id).maybeSingle()
  if (!r) return NextResponse.json({ error: 'Introuvable / Not found' }, { status: 404 })
  const sandbox = isSandboxMoney()
  const { data: payouts } = await supabaseAdmin.from('pro_payouts').select('id, amount, phone, day, status, created_at, completed_at')
    .eq('party_type', 'restaurant').eq('party_id', params.id).eq('is_test', sandbox).order('created_at', { ascending: false }).limit(10)
  return NextResponse.json({
    balances: await restaurantBalances(params.id), sandbox,
    payout_phone: (r.payout_phone as string | null) ?? (r.whatsapp as string | null), payout_phone_pending: r.payout_phone_pending ?? null,
    payouts: payouts ?? [],
  }, { headers: { 'Cache-Control': 'no-store' } })
}
