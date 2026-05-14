import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'
import { isReason, isTargetType } from '@/lib/reports'

export const dynamic = 'force-dynamic'

// POST /api/reports
// Body: { target_type, target_id, reason, description? }
//
// Reporter is captured via the session — the row stays anonymous to the
// reported party (admin sees the reporter, the public never does). Per
// spec we don't notify the reported user. Login is required so we have
// at least one rate-limit lever (per-customer flood protection lands as
// a follow-up).
export async function POST(req: NextRequest) {
  const session = getSessionFromRequest(req)
  if (!session || session.role !== 'customer') {
    return NextResponse.json({ error: 'Connexion requise / Login required' }, { status: 401 })
  }

  const body = await req.json().catch(() => ({}))
  if (!isTargetType(body?.target_type)) {
    return NextResponse.json({ error: 'target_type invalide / invalid' }, { status: 400 })
  }
  if (!isReason(body?.reason)) {
    return NextResponse.json({ error: 'Raison invalide / Invalid reason' }, { status: 400 })
  }
  const targetId = typeof body?.target_id === 'string' ? body.target_id : ''
  if (!targetId) {
    return NextResponse.json({ error: 'target_id requis / required' }, { status: 400 })
  }
  const description = typeof body?.description === 'string' ? body.description.trim().slice(0, 500) : null

  // Verify the target exists. Cheap existence check per target type — the
  // CHECK on reports.target_type already restricts the set.
  const targetExists = await (async () => {
    if (body.target_type === 'restaurant') {
      const { data } = await supabaseAdmin.from('restaurants').select('id').eq('id', targetId).maybeSingle()
      return !!data
    }
    if (body.target_type === 'event') {
      const { data } = await supabaseAdmin.from('events').select('id').eq('id', targetId).maybeSingle()
      return !!data
    }
    const { data } = await supabaseAdmin.from('event_comments').select('id').eq('id', targetId).maybeSingle()
    return !!data
  })()
  if (!targetExists) {
    return NextResponse.json({ error: 'Cible introuvable / Target not found' }, { status: 404 })
  }

  const { data, error } = await supabaseAdmin
    .from('reports')
    .insert({
      reporter_id: session.id,
      target_type: body.target_type,
      target_id:   targetId,
      reason:      body.reason,
      description,
    })
    .select('id').single()
  if (error || !data) {
    console.error('[reports] insert failed:', error?.message)
    return NextResponse.json({ error: error?.message ?? 'Erreur / Error' }, { status: 500 })
  }

  await writeAudit({
    action:          'report_submitted',
    targetType:      body.target_type === 'comment' ? 'event' : body.target_type,
    targetId,
    performedBy:     session.id,
    performedByType: 'customer',
    metadata:        { report_id: data.id, reason: body.reason, target_type: body.target_type },
  })

  return NextResponse.json({ ok: true, report_id: data.id })
}
