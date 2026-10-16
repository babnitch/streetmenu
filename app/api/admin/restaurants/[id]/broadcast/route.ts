import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'

export const dynamic = 'force-dynamic'

// PATCH { broadcast_enabled: boolean } — super_admin / admin grant or revoke
// a restaurant's paid-broadcast capability (default OFF). Moderators may read
// the admin dashboard but must NOT change it.
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionFromRequest(req)
  if (!session) return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })

  if (!['super_admin', 'admin'].includes(session.role)) {
    return NextResponse.json({ error: 'Permission insuffisante / Insufficient permission' }, { status: 403 })
  }

  let body: { broadcast_enabled?: unknown }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'invalid json' }, { status: 400 }) }
  if (typeof body.broadcast_enabled !== 'boolean') {
    return NextResponse.json({ error: 'broadcast_enabled (boolean) requis / required' }, { status: 400 })
  }

  const { data: before } = await supabaseAdmin
    .from('restaurants')
    .select('broadcast_enabled, name')
    .eq('id', params.id)
    .maybeSingle()
  if (!before) return NextResponse.json({ error: 'Restaurant introuvable / not found' }, { status: 404 })

  const { error } = await supabaseAdmin
    .from('restaurants')
    .update({ broadcast_enabled: body.broadcast_enabled })
    .eq('id', params.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await writeAudit({
    action:          'broadcast_capability_updated',
    targetType:      'restaurant',
    targetId:        params.id,
    performedBy:     session.id,
    performedByType: session.role,
    previousData:    { broadcast_enabled: before.broadcast_enabled, name: before.name },
    metadata:        { broadcast_enabled: body.broadcast_enabled, by: 'admin' },
  })

  return NextResponse.json({ ok: true, broadcast_enabled: body.broadcast_enabled })
}
