import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'

export const dynamic = 'force-dynamic'

// PATCH /api/promotions/[id]
// Body: { action: 'pause' | 'resume' | 'cancel' }
// Only the promoter (or an admin) can update the row. Allowed
// transitions:
//   active   → paused   (action=pause)
//   paused   → active   (action=resume)
//   draft    → rejected (action=cancel — cancel a never-paid draft)
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionFromRequest(req)
  if (!session) return NextResponse.json({ error: 'Connexion requise / Login required' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const action = String(body?.action ?? '').toLowerCase()
  if (!['pause', 'resume', 'cancel'].includes(action)) {
    return NextResponse.json({ error: 'action invalide' }, { status: 400 })
  }

  const { data: promo } = await supabaseAdmin
    .from('promotions')
    .select('id, promoter_id, status')
    .eq('id', params.id)
    .maybeSingle()
  if (!promo) return NextResponse.json({ error: 'Introuvable / Not found' }, { status: 404 })

  const isAdmin = ['super_admin', 'admin', 'moderator'].includes(session.role)
  if (!isAdmin && promo.promoter_id !== session.id) {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 403 })
  }

  let nextStatus: string | null = null
  let auditAction = ''
  if (action === 'pause') {
    if (promo.status !== 'active') return NextResponse.json({ error: 'Statut invalide pour pause' }, { status: 400 })
    nextStatus = 'paused'; auditAction = 'promotion_paused'
  } else if (action === 'resume') {
    if (promo.status !== 'paused') return NextResponse.json({ error: 'Statut invalide pour reprise' }, { status: 400 })
    nextStatus = 'active'; auditAction = 'promotion_resumed'
  } else {
    if (promo.status !== 'draft') return NextResponse.json({ error: 'Seuls les brouillons peuvent être annulés' }, { status: 400 })
    nextStatus = 'rejected'; auditAction = 'promotion_cancelled'
  }

  const { error } = await supabaseAdmin
    .from('promotions')
    .update({ status: nextStatus, updated_at: new Date().toISOString() })
    .eq('id', promo.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await writeAudit({
    action:          auditAction,
    targetType:      'promotion',
    targetId:        promo.id,
    performedBy:     session.id,
    performedByType: session.role,
    previousData:    { status: promo.status },
    metadata:        { new_status: nextStatus },
  })

  return NextResponse.json({ ok: true })
}
