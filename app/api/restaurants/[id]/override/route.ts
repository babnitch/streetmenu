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
  // Two independent toggles, either may be present; both map to the same
  // commercial-state surface so they share an endpoint.
  const update: Record<string, unknown> = {}
  let auditAction: string | null = null

  if ('override' in body) {
    const override: unknown = body.override
    if (override !== 'open' && override !== 'closed' && override !== null) {
      return NextResponse.json({ error: 'override must be open | closed | null' }, { status: 400 })
    }
    update.manual_override    = override
    update.manual_override_at = override === null ? null : new Date().toISOString()
    auditAction = override === null ? 'manual_override_removed' : 'manual_override_set'
  }

  if ('allow_orders_when_closed' in body) {
    if (typeof body.allow_orders_when_closed !== 'boolean') {
      return NextResponse.json({ error: 'allow_orders_when_closed must be boolean' }, { status: 400 })
    }
    update.allow_orders_when_closed = body.allow_orders_when_closed
    auditAction = auditAction ?? 'allow_orders_toggled'
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
  }

  const { error } = await supabaseAdmin
    .from('restaurants').update(update).eq('id', params.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  if (auditAction) {
    await writeAudit({
      action:          auditAction,
      targetType:      'restaurant',
      targetId:        params.id,
      performedBy:     session.id,
      performedByType: isAdmin ? session.role : 'vendor',
      metadata:        update,
    })
  }

  return NextResponse.json({ ok: true, ...update })
}
