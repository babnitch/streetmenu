import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'

export const dynamic = 'force-dynamic'

// POST /api/admin/broadcasts/block-sender
// Body: { customer_id: string, blocked: boolean, reason?: string }
// Flips customers.broadcast_blocked. Idempotent.
export async function POST(req: NextRequest) {
  const session = getSessionFromRequest(req)
  if (!session || !['super_admin', 'admin', 'moderator'].includes(session.role)) {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }

  const body = await req.json().catch(() => ({}))
  const customerId = String(body?.customer_id ?? '').trim()
  const blocked = !!body?.blocked
  const reason = body?.reason ? String(body.reason) : null
  if (!customerId) {
    return NextResponse.json({ error: 'customer_id requis / required' }, { status: 400 })
  }

  const { data: existing } = await supabaseAdmin
    .from('customers')
    .select('id, broadcast_blocked')
    .eq('id', customerId)
    .maybeSingle()
  if (!existing) {
    return NextResponse.json({ error: 'Compte introuvable / Account not found' }, { status: 404 })
  }

  const { error } = await supabaseAdmin
    .from('customers')
    .update({ broadcast_blocked: blocked })
    .eq('id', customerId)
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  await writeAudit({
    action:          blocked ? 'broadcast_blocked' : 'broadcast_unblocked',
    targetType:      'customer',
    targetId:        customerId,
    performedBy:     session.id,
    performedByType: session.role,
    previousData:    { broadcast_blocked: existing.broadcast_blocked },
    metadata:        { reason },
  })

  return NextResponse.json({ ok: true })
}
