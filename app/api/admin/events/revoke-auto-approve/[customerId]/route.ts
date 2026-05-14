import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'
import { sendWhatsApp } from '@/lib/whatsapp'

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

  await supabaseAdmin
    .from('customers')
    .update({ event_auto_approve: false })
    .eq('id', customer.id)

  await writeAudit({
    action:          'auto_approve_revoked',
    targetType:      'customer',
    targetId:        customer.id,
    performedBy:     session.id,
    performedByType: session.role,
    previousData:    { event_auto_approve: true, events_approved_count: customer.events_approved_count },
    metadata:        { reason },
  })

  if (customer.phone) {
    const reasonLine = reason ? `\n📝 Raison / Reason: ${reason}` : ''
    await sendWhatsApp(customer.phone,
      `⚠️ *Auto-approbation révoquée / Auto-approve revoked*\n\n` +
      `Vos prochains événements passeront à nouveau par la validation admin.${reasonLine}\n` +
      `Your next events will require admin review again.`,
    ).catch(() => null)
  }

  return NextResponse.json({ ok: true })
}
