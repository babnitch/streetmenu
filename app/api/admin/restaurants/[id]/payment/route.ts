import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'

export const dynamic = 'force-dynamic'

// PATCH { payment_enabled } — super_admin / admin enable or disable online
// payment (PawaPay MoMo) for any restaurant. Moderators can read the admin
// dashboard but must NOT flip the payment configuration.
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionFromRequest(req)
  if (!session) return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })

  // Admin-side action: only super_admin and admin — not moderator, not vendor.
  if (!['super_admin', 'admin'].includes(session.role)) {
    return NextResponse.json({ error: 'Permission insuffisante / Insufficient permission' }, { status: 403 })
  }

  let body: { payment_enabled?: boolean }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'invalid json' }, { status: 400 }) }

  if (typeof body.payment_enabled !== 'boolean') {
    return NextResponse.json({ error: 'payment_enabled (boolean) requis / required' }, { status: 400 })
  }

  const { data: before } = await supabaseAdmin
    .from('restaurants')
    .select('payment_enabled, name')
    .eq('id', params.id)
    .maybeSingle()
  if (!before) return NextResponse.json({ error: 'Restaurant introuvable / not found' }, { status: 404 })

  const { error } = await supabaseAdmin
    .from('restaurants')
    .update({ payment_enabled: body.payment_enabled })
    .eq('id', params.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await writeAudit({
    action:          body.payment_enabled ? 'payment_enabled' : 'payment_disabled',
    targetType:      'restaurant',
    targetId:        params.id,
    performedBy:     session.id,
    performedByType: session.role,
    previousData:    { payment_enabled: before.payment_enabled, name: before.name },
    metadata:        { payment_enabled: body.payment_enabled, by: 'admin' },
  })

  return NextResponse.json({ ok: true, payment_enabled: body.payment_enabled })
}
