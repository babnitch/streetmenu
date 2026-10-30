import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromRequest } from '@/lib/auth'
import { decidePayoutPhone } from '@/lib/proPayouts'

export const dynamic = 'force-dynamic'

// POST /api/admin/payouts/phone { restaurant_id, approve } — confirm or
// decline a pro's new payout number. Admins, audited.
export async function POST(req: NextRequest) {
  const s = getSessionFromRequest(req)
  if (!s || !['super_admin', 'admin'].includes(s.role)) return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  const body = await req.json().catch(() => ({})) as { restaurant_id?: unknown; approve?: unknown }
  if (typeof body.restaurant_id !== 'string' || typeof body.approve !== 'boolean') return NextResponse.json({ error: 'restaurant_id, approve' }, { status: 400 })
  const r = await decidePayoutPhone(body.restaurant_id, body.approve, { id: s.id, type: s.role })
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status })
  return NextResponse.json({ ok: true })
}
