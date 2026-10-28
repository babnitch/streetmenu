import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'
import { switchModule } from '@/lib/modulesServer'

export const dynamic = 'force-dynamic'

// PATCH { broadcast_enabled: boolean } — super_admin / admin grant or revoke
// a customer's capability to send paid broadcasts as an event publisher
// (default OFF). customers.broadcast_blocked still overrides it.
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
    .from('customers')
    .select('broadcast_enabled, name')
    .eq('id', params.id)
    .maybeSingle()
  if (!before) return NextResponse.json({ error: 'Compte introuvable / Account not found' }, { status: 404 })

  // Through the modules (M1): the organiser's Diffusion module and this flag stay one.
  const sw = await switchModule('organizer', params.id, 'broadcast', body.broadcast_enabled, { id: session.id, type: session.role }, 'broadcast_toggle')
  if (!sw.ok) return NextResponse.json({ error: sw.error }, { status: sw.status })

  await writeAudit({
    action:          'broadcast_capability_updated',
    targetType:      'customer',
    targetId:        params.id,
    performedBy:     session.id,
    performedByType: session.role,
    previousData:    { broadcast_enabled: before.broadcast_enabled, name: before.name },
    metadata:        { broadcast_enabled: body.broadcast_enabled, by: 'admin' },
  })

  return NextResponse.json({ ok: true, broadcast_enabled: body.broadcast_enabled })
}
