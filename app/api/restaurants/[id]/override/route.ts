import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'

export const dynamic = 'force-dynamic'

// POST /api/restaurants/[id]/override
// Body: { override: 'open' | 'closed' | null }
//
// Manual short-circuit for the schedule. Allowed roles: owner, manager
// (manager can flip "we're slammed, close orders" without owner present).
// Staff cannot — they can be on shift but not change commercial state.
// Admins bypass.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionFromRequest(req)
  if (!session) return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })

  const isAdmin = ['super_admin', 'admin', 'moderator'].includes(session.role)
  if (!isAdmin) {
    const { data: direct } = await supabaseAdmin
      .from('restaurants').select('id').eq('id', params.id).eq('customer_id', session.id).maybeSingle()
    if (!direct) {
      const { data: team } = await supabaseAdmin
        .from('restaurant_team').select('role')
        .eq('restaurant_id', params.id).eq('customer_id', session.id)
        .eq('status', 'active').in('role', ['owner', 'manager']).maybeSingle()
      if (!team) return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 403 })
    }
  }

  const body = await req.json().catch(() => ({}))
  const override: unknown = body?.override
  if (override !== 'open' && override !== 'closed' && override !== null) {
    return NextResponse.json({ error: 'override must be open | closed | null' }, { status: 400 })
  }

  const { error } = await supabaseAdmin
    .from('restaurants')
    .update({
      manual_override:    override,
      manual_override_at: override === null ? null : new Date().toISOString(),
    })
    .eq('id', params.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await writeAudit({
    action:          override === null ? 'manual_override_removed' : 'manual_override_set',
    targetType:      'restaurant',
    targetId:        params.id,
    performedBy:     session.id,
    performedByType: isAdmin ? session.role : 'vendor',
    metadata:        { override },
  })

  return NextResponse.json({ ok: true, override })
}
