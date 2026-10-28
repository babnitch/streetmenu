import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromRequest } from '@/lib/auth'
import { decideModuleRequest } from '@/lib/moduleRequests'

export const dynamic = 'force-dynamic'

// POST /api/admin/module-requests/[id] { decision: 'approve' | 'decline' } (M5)
// Approve switches the module on (with what it needs), audited; the pro gets
// one WhatsApp either way. super_admin / admin only.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const s = getSessionFromRequest(req)
  if (!s || !['super_admin', 'admin'].includes(s.role)) return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  const body = await req.json().catch(() => ({}))
  if (body?.decision !== 'approve' && body?.decision !== 'decline') {
    return NextResponse.json({ error: 'decision: approve | decline' }, { status: 400 })
  }
  const r = await decideModuleRequest(params.id, body.decision === 'approve', { id: s.id, type: s.role })
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status })
  return NextResponse.json({ ok: true, modules: r.modules })
}
