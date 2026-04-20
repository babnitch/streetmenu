import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'

export const dynamic = 'force-dynamic'

// DELETE /api/restaurants/[id]/invite/[invitationId]
// Cancels a pending team invitation. Owner-only. Idempotent — an already-
// cancelled/declined/expired row returns 200 so the UI can just refresh.
export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string; invitationId: string } },
) {
  const session = getSessionFromRequest(req)
  if (!session || session.role !== 'customer') {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }

  const { data: ownerEntry } = await supabaseAdmin
    .from('restaurant_team').select('role')
    .eq('restaurant_id', params.id).eq('customer_id', session.id).eq('status', 'active').maybeSingle()

  if (!ownerEntry || ownerEntry.role !== 'owner') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { data: invitation } = await supabaseAdmin
    .from('team_invitations').select('id, restaurant_id, phone, role, status')
    .eq('id', params.invitationId).maybeSingle()

  if (!invitation || invitation.restaurant_id !== params.id) {
    return NextResponse.json({ error: 'Invitation introuvable / Not found' }, { status: 404 })
  }

  if (invitation.status !== 'pending') {
    return NextResponse.json({ ok: true, noop: true })
  }

  await supabaseAdmin
    .from('team_invitations')
    .update({ status: 'cancelled' })
    .eq('id', invitation.id)

  await writeAudit({
    action: 'team_invitation_cancelled',
    targetType: 'restaurant_team',
    targetId: invitation.id,
    performedBy: session.id,
    performedByType: 'vendor',
    metadata: {
      restaurant_id: params.id,
      phone: invitation.phone,
      role: invitation.role,
    },
  })

  return NextResponse.json({ ok: true })
}
