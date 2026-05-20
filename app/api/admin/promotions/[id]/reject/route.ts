import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'
import { sendWhatsApp } from '@/lib/whatsapp'

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

  const promoterPhone = (promo.customers as unknown as { phone?: string } | null)?.phone
  if (promoterPhone) {
    await sendWhatsApp(promoterPhone,
      `❌ *Promotion rejetée / Promotion rejected*\n\n` +
      (reason ? `Raison: ${reason}\n\n` : '') +
      `Contactez le support pour plus de détails. / Contact support for details.`,
    ).catch(() => null)
  }

  return NextResponse.json({ ok: true })
}
