import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { rateLimit } from '@/lib/rateLimit'
import { reportProblem } from '@/lib/protectedPayments'

export const dynamic = 'force-dynamic'

// POST /api/orders/[id]/problem { reason } — "Problème avec ma commande":
// the customer's own protected order. The money stays held, auto-release
// stops, the admins decide.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionFromRequest(req)
  if (!session || session.role !== 'customer') return NextResponse.json({ error: 'Connexion requise / Login required' }, { status: 401 })
  const hit = rateLimit({ key: `problem:${session.id}`, max: 5, windowMs: 3600_000 })
  if (hit) return NextResponse.json({ error: hit.message }, { status: 429 })
  const { data: o } = await supabaseAdmin.from('orders').select('id, customer_id').eq('id', params.id).maybeSingle()
  if (!o || o.customer_id !== session.id) return NextResponse.json({ error: 'Commande introuvable / Order not found' }, { status: 404 })
  const body = await req.json().catch(() => ({})) as { reason?: unknown }
  const reason = String(body.reason ?? '').trim()
  if (reason.length < 3) return NextResponse.json({ error: 'Dites-nous ce qui ne va pas / Tell us what is wrong' }, { status: 400 })
  const r = await reportProblem(o.id as string, session.id, 'web', reason)
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status })
  return NextResponse.json({ ok: true, id: r.id })
}
