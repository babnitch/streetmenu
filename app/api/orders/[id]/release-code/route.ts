import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { rateLimit } from '@/lib/rateLimit'
import { isTeamOrAdmin, ADMIN_ROLES } from '@/lib/teamAccess'
import { releaseWithCode } from '@/lib/protectedPayments'

export const dynamic = 'force-dynamic'

// POST /api/orders/[id]/release-code { code } — the restaurant types the
// customer's hand-over code for THIS order: right → handed over + money
// released; wrong → one try counted (locked after the max, admins alerted;
// 20 wrong codes per restaurant per hour block code entry).
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionFromRequest(req)
  if (!session) return NextResponse.json({ error: 'Connexion requise / Login required' }, { status: 401 })
  const hit = rateLimit({ key: `release-code:${session.id}`, max: 30, windowMs: 600_000 })
  if (hit) return NextResponse.json({ error: hit.message }, { status: 429 })
  const { data: o } = await supabaseAdmin.from('orders').select('id, restaurant_id').eq('id', params.id).maybeSingle()
  if (!o || !(await isTeamOrAdmin(session, o.restaurant_id as string))) {
    return NextResponse.json({ error: 'Commande introuvable / Order not found' }, { status: 404 })
  }
  const body = await req.json().catch(() => ({})) as { code?: unknown }
  const r = await releaseWithCode(o.id as string, String(body.code ?? ''),
    { id: session.id, type: ADMIN_ROLES.includes(session.role) ? 'admin' : 'vendor' }, 'app')
  if (!r.ok) return NextResponse.json({ error: r.error, reason: r.reason, tries_left: r.triesLeft }, { status: r.status })
  return NextResponse.json({ ok: true, amount: r.amount, commission: r.commission })
}
