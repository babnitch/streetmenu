import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'
import { sendWhatsApp } from '@/lib/whatsapp'

export const dynamic = 'force-dynamic'

// POST /api/admin/promotions/[id]/approve
// Flips a pending_review promotion to active. Idempotent — re-approving
// an already-active row is a no-op aside from re-pinging the promoter.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionFromRequest(req)
  if (!session || !['super_admin', 'admin', 'moderator'].includes(session.role)) {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }

  const { data: promo } = await supabaseAdmin
    .from('promotions')
    .select('id, promoter_id, status, target_type, target_id, customers(phone)')
    .eq('id', params.id)
    .maybeSingle()
  if (!promo) return NextResponse.json({ error: 'Introuvable / Not found' }, { status: 404 })

  if (promo.status !== 'pending_review') {
    return NextResponse.json({ error: `Statut invalide: ${promo.status}` }, { status: 400 })
  }

  await supabaseAdmin
    .from('promotions')
    .update({
      status:      'active',
      reviewed_by: session.id,
      updated_at:  new Date().toISOString(),
    })
    .eq('id', promo.id)

  await writeAudit({
    action:          'promotion_approved',
    targetType:      'promotion',
    targetId:        promo.id,
    performedBy:     session.id,
    performedByType: session.role,
    previousData:    { status: promo.status },
  })

  const promoterPhone = (promo.customers as unknown as { phone?: string } | null)?.phone
  if (promoterPhone) {
    await sendWhatsApp(promoterPhone,
      `✅ *Promotion approuvée! / Promotion approved!*\n\n` +
      `Votre promotion est maintenant active. Bonne chance!\n` +
      `Your promotion is now live. Good luck!`,
    ).catch(() => null)
  }

  return NextResponse.json({ ok: true })
}
