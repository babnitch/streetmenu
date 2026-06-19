import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'

export const dynamic = 'force-dynamic'

// PATCH { payment_enabled } — super_admin / admin enable or disable online
// ticket payment (PawaPay MoMo) for an event. Moderators may read the admin
// dashboard but must NOT flip the payment configuration.
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionFromRequest(req)
  if (!session) return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })

  // Admin-side action: only super_admin and admin — not moderator, not organizer.
  if (!['super_admin', 'admin'].includes(session.role)) {
    return NextResponse.json({ error: 'Permission insuffisante / Insufficient permission' }, { status: 403 })
  }

  let body: { payment_enabled?: boolean }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'invalid json' }, { status: 400 }) }

  if (typeof body.payment_enabled !== 'boolean') {
    return NextResponse.json({ error: 'payment_enabled (boolean) requis / required' }, { status: 400 })
  }

  const { data: before } = await supabaseAdmin
    .from('events')
    .select('payment_enabled, title, ticket_price')
    .eq('id', params.id)
    .maybeSingle()
  if (!before) return NextResponse.json({ error: 'Événement introuvable / not found' }, { status: 404 })

  // Enabling online payment on a free event would be meaningless — block it so
  // the dashboard can't push the row into a nonsensical state.
  if (body.payment_enabled && !(Number(before.ticket_price ?? 0) > 0)) {
    return NextResponse.json({ error: 'Billet gratuit — paiement impossible / Free ticket — no payment' }, { status: 400 })
  }

  const { error } = await supabaseAdmin
    .from('events')
    .update({ payment_enabled: body.payment_enabled })
    .eq('id', params.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await writeAudit({
    action:          body.payment_enabled ? 'event_payment_enabled' : 'event_payment_disabled',
    targetType:      'event',
    targetId:        params.id,
    performedBy:     session.id,
    performedByType: session.role,
    previousData:    { payment_enabled: before.payment_enabled, title: before.title },
    metadata:        { payment_enabled: body.payment_enabled, by: 'admin' },
  })

  return NextResponse.json({ ok: true, payment_enabled: body.payment_enabled })
}
