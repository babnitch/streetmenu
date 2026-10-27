import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'

export const dynamic = 'force-dynamic'

// POST /api/admin/promotions/[id]/reject
// Body: { reason?: string }
// Used both for pending-review denials and for taking down an active
// promotion that violates policy. Money refund is a manual ops step
// for now — out of scope.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionFromRequest(req)
  if (!session || !['super_admin', 'admin', 'moderator'].includes(session.role)) {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }

  const body = await req.json().catch(() => ({}))
  const reason = body?.reason ? String(body.reason) : null

  const { data: promo } = await supabaseAdmin
    .from('promotions')
    .select('id, promoter_id, status, customers(phone)')
    .eq('id', params.id)
    .maybeSingle()
  if (!promo) return NextResponse.json({ error: 'Introuvable / Not found' }, { status: 404 })

  await supabaseAdmin
    .from('promotions')
    .update({
      status:          'rejected',
      reviewed_by:     session.id,
      rejection_reason: reason,
      updated_at:      new Date().toISOString(),
    })
    .eq('id', promo.id)

  await writeAudit({
    action:          'promotion_rejected',
    targetType:      'promotion',
    targetId:        promo.id,
    performedBy:     session.id,
    performedByType: session.role,
    previousData:    { status: promo.status },
    metadata:        { reason },
  })

  // No WhatsApp message to the promoter (decision D): they see the status
  // in Account → Promouvoir.

  return NextResponse.json({ ok: true })
}
