import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { checkPayoutStatus } from '@/lib/pawapay'
import { settlePayoutTest } from '@/lib/payoutTests'

export const dynamic = 'force-dynamic'

// GET /api/admin/pawapay/payout-test/[payoutId] (R3) — status for the
// admin's screen; still pending → asks PawaPay. Super admin only.
export async function GET(req: NextRequest, { params }: { params: { payoutId: string } }) {
  const s = getSessionFromRequest(req)
  if (!s || s.role !== 'super_admin') return NextResponse.json({ error: 'Réservé au super admin / Super admin only' }, { status: 403 })
  if (!/^[0-9a-f-]{36}$/i.test(params.payoutId)) return NextResponse.json({ error: 'Introuvable / Not found' }, { status: 404 })
  const load = async () => (await supabaseAdmin.from('payout_tests').select('*').eq('id', params.payoutId).maybeSingle()).data
  let test = await load()
  if (!test) return NextResponse.json({ error: 'Introuvable / Not found' }, { status: 404 })
  if (test.status === 'pending') {
    try {
      const st = await checkPayoutStatus(params.payoutId)
      if (!st.notFound) { await settlePayoutTest(params.payoutId, st.status, st.failureReason, st.receivedAt); test = await load() }
    } catch (e) { console.error('[payout-test] status check failed:', (e as Error).message) }
  }
  return NextResponse.json({ test }, { headers: { 'Cache-Control': 'no-store' } })
}
