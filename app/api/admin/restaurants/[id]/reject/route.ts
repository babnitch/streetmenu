import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'

export const dynamic = 'force-dynamic'

// POST /api/admin/restaurants/[id]/reject   Body: { reason?: string }
//
// Rejects a signup that never made it past moderation. Never deleted (soft
// deletion rule, CLAUDE.md): status 'rejected' + rejected_by / at / reason.
// deleted_at is set too, so every list (they all filter deleted_at IS NULL)
// hides it at once and the number can sign up again; the owner's team row is
// set 'removed'. Shown only under Admin → Restaurants → Rejetés. Audited.
//
// Authorization: sm_session JWT with role super_admin | admin. Moderators are
// excluded, matching /api/restaurants/[id]/approve.
//
// Safety guard: only a row that is still un-approved (is_active = false) and
// not already deleted / rejected.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionFromRequest(req)
  if (!session || !['super_admin', 'admin'].includes(session.role)) {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }
  const body = await req.json().catch(() => ({}))
  const reason = typeof body?.reason === 'string' && body.reason.trim() ? body.reason.trim().slice(0, 500) : null

  const { data: before, error: readErr } = await supabaseAdmin
    .from('restaurants')
    .select('id, name, city, whatsapp, is_active, status, deleted_at, customer_id')
    .eq('id', params.id)
    .maybeSingle()

  if (readErr) return NextResponse.json({ error: readErr.message }, { status: 500 })
  if (!before)  return NextResponse.json({ error: 'Restaurant introuvable / Not found' }, { status: 404 })

  if (before.is_active) {
    return NextResponse.json(
      {
        error: 'Ce restaurant est actif — utilisez la suppression. / '
             + 'This restaurant is live — use delete instead.',
      },
      { status: 409 },
    )
  }
  if (before.status === 'rejected') {
    return NextResponse.json({ error: 'Déjà rejeté / Already rejected' }, { status: 409 })
  }
  if (before.deleted_at) {
    return NextResponse.json({ error: 'Déjà supprimé / Already deleted' }, { status: 400 })
  }

  const now = new Date().toISOString()
  const { error } = await supabaseAdmin
    .from('restaurants')
    .update({
      status: 'rejected', is_active: false, is_open: false,
      rejected_at: now, rejected_by: session.id, rejection_reason: reason, deleted_at: now,
    })
    .eq('id', params.id)
    .is('deleted_at', null)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // The applicant loses the pro access to it (kept, not deleted).
  await supabaseAdmin.from('restaurant_team').update({ status: 'removed' })
    .eq('restaurant_id', params.id).eq('status', 'active')

  await writeAudit({
    action:          'restaurant_rejected',
    targetType:      'restaurant',
    targetId:        params.id,
    performedBy:     session.id,
    performedByType: session.role,
    previousData:    {
      name: before.name, city: before.city, status: before.status,
      whatsapp: before.whatsapp, customer_id: before.customer_id,
    },
    metadata:        { reason },
  })

  return NextResponse.json({ ok: true })
}
