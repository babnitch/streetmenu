import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'
import { switchModule } from '@/lib/modulesServer'

export const dynamic = 'force-dynamic'

// POST /api/admin/events/revoke-auto-approve/[customerId]
// Body: { reason?: string }
// Sets event_auto_approve=false so the publisher's next events route back
// through admin review. The approval counter is intentionally NOT reset —
// the publisher can still earn the trust back without re-passing the 3
// threshold (admin re-grants by setting the flag manually if needed).
export async function POST(req: NextRequest, { params }: { params: { customerId: string } }) {
  const session = getSessionFromRequest(req)
  if (!session || !['super_admin', 'admin', 'moderator'].includes(session.role)) {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }

  const body = await req.json().catch(() => ({}))
  const reason = typeof body?.reason === 'string' ? body.reason.trim().slice(0, 500) : null

  const { data: customer } = await supabaseAdmin
    .from('customers')
    .select('id, phone, event_auto_approve, events_approved_count')
    .eq('id', params.customerId)
    .maybeSingle()
  if (!customer) return NextResponse.json({ error: 'Compte introuvable / Account not found' }, { status: 404 })

  if (!customer.event_auto_approve) {
    return NextResponse.json({ ok: true, ignored: 'not auto-approved' })
  }

  // Through the modules (M1): Auto-approbation and this flag stay one.
  await switchModule('organizer', customer.id, 'auto_approve', false, { id: session.id, type: session.role }, 'auto_approve_revoked')

  await writeAudit({
    action:          'auto_approve_revoked',
    targetType:      'customer',
    targetId:        customer.id,
    performedBy:     session.id,
    performedByType: session.role,
    previousData:    { event_auto_approve: true, events_approved_count: customer.events_approved_count },
    metadata:        { reason },
  })

  // No WhatsApp message (decision D): the organiser sees it when their next
  // event waits for review.

  return NextResponse.json({ ok: true })
}
