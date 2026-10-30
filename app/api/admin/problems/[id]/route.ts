import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromRequest } from '@/lib/auth'
import { resolveProblem, type Decision } from '@/lib/protectedPayments'

export const dynamic = 'force-dynamic'

// POST /api/admin/problems/[id] { decision: 'release' | 'refund' | 'partial', amount?, note? }
// release → the held money goes to the restaurant; refund → all of it back
// to the customer; partial → refund `amount`, the rest to the restaurant
// once the refund completes. Audited.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const s = getSessionFromRequest(req)
  if (!s || !['super_admin', 'admin'].includes(s.role)) return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  const body = await req.json().catch(() => ({})) as { decision?: unknown; amount?: unknown; note?: unknown }
  let d: Decision
  if (body.decision === 'release') d = { kind: 'release' }
  else if (body.decision === 'refund') d = { kind: 'refund' }
  else if (body.decision === 'partial') d = { kind: 'partial', amount: Number(body.amount) }
  else return NextResponse.json({ error: 'decision: release | refund | partial' }, { status: 400 })
  const r = await resolveProblem(params.id, d, { id: s.id, type: s.role }, String(body.note ?? ''))
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status })
  return NextResponse.json({ ok: true })
}
