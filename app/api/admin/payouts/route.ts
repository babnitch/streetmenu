import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromRequest } from '@/lib/auth'
import { toPayList, payRestaurant } from '@/lib/proPayouts'
import { isSandboxMoney } from '@/lib/protectedPayments'

export const dynamic = 'force-dynamic'

// Admin → Commandes → À payer (protected payments, P2). Admins.
// GET → { rows, sandbox }   POST { restaurant_id } → pays the whole available balance.
function admin(req: NextRequest) {
  const s = getSessionFromRequest(req)
  return s && ['super_admin', 'admin'].includes(s.role) ? s : null
}

export async function GET(req: NextRequest) {
  if (!admin(req)) return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  return NextResponse.json({ rows: await toPayList(), sandbox: isSandboxMoney() }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(req: NextRequest) {
  const s = admin(req)
  if (!s) return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  const body = await req.json().catch(() => ({})) as { restaurant_id?: unknown }
  if (typeof body.restaurant_id !== 'string') return NextResponse.json({ error: 'restaurant_id' }, { status: 400 })
  const r = await payRestaurant(body.restaurant_id, { id: s.id, type: s.role })
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status })
  return NextResponse.json({ ok: true, payout_id: r.payoutId, amount: r.amount, status: r.status })
}
