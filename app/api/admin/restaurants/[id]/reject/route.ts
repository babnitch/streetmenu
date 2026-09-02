import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'

export const dynamic = 'force-dynamic'

// POST /api/admin/restaurants/[id]/reject
//
// Hard-deletes a signup that never made it past moderation. This is NOT the
// same operation as /api/restaurants/[id]/delete, which soft-deletes a live
// restaurant (deleted_at + status='deleted') and is reachable by the owner.
// Rejecting a pending application purges the row outright, mirroring
// /api/admin/events/[id]/reject.
//
// Replaces a browser-side anon-key DELETE on the restaurants table whose
// only gate was a localStorage flag.
//
// Authorization: sm_session JWT with role super_admin | admin. Moderators are
// excluded, matching /api/restaurants/[id]/approve — approve and reject are
// two halves of one decision and carry the same bar.
//
// Safety guard: only a row that is still un-approved (is_active = false) and
// not already soft-deleted can be purged here, so this route can never be
// used to erase a live restaurant and its order history.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionFromRequest(req)
  if (!session || !['super_admin', 'admin'].includes(session.role)) {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }

  const { data: before, error: readErr } = await supabaseAdmin
    .from('restaurants')
    .select('id, name, city, whatsapp, is_active, deleted_at, customer_id')
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
  if (before.deleted_at) {
    return NextResponse.json({ error: 'Déjà supprimé / Already deleted' }, { status: 400 })
  }

  const { error } = await supabaseAdmin
    .from('restaurants')
    .delete()
    .eq('id', params.id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await writeAudit({
    action:          'restaurant_rejected',
    targetType:      'restaurant',
    targetId:        params.id,
    performedBy:     session.id,
    performedByType: session.role,
    previousData:    {
      name: before.name, city: before.city,
      whatsapp: before.whatsapp, customer_id: before.customer_id,
    },
  })

  return NextResponse.json({ ok: true })
}
