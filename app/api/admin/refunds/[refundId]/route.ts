import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { checkRefundStatus } from '@/lib/pawapay'
import { settleRefund } from '@/lib/refunds'

export const dynamic = 'force-dynamic'

// GET /api/admin/refunds/[refundId] (R2) — the refund, for the admin's
// screen. Still pending → asks PawaPay and settles (atomic, like the
// webhook). Super admin only.
export async function GET(req: NextRequest, { params }: { params: { refundId: string } }) {
  const s = getSessionFromRequest(req)
  if (!s || s.role !== 'super_admin') return NextResponse.json({ error: 'Réservé au super admin / Super admin only' }, { status: 403 })
  if (!/^[0-9a-f-]{36}$/i.test(params.refundId)) return NextResponse.json({ error: 'Introuvable / Not found' }, { status: 404 })
  const load = async () => (await supabaseAdmin.from('refunds').select('*').eq('id', params.refundId).maybeSingle()).data
  let refund = await load()
  if (!refund) return NextResponse.json({ error: 'Introuvable / Not found' }, { status: 404 })
  if (refund.status === 'pending') {
    try {
      const st = await checkRefundStatus(params.refundId)
      if (!st.notFound) {
        await settleRefund(params.refundId, { status: st.status, failureReason: st.failureReason }, 'status_poll')
        refund = await load()
      }
    } catch (e) { console.error('[refund] status check failed:', (e as Error).message) }
  }
  return NextResponse.json({ refund }, { headers: { 'Cache-Control': 'no-store' } })
}
