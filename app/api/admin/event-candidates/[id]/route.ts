import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'
import { IGNORE_REASONS, type IgnoreReason } from '@/lib/discovery/candidates'

export const dynamic = 'force-dynamic'

// POST /api/admin/event-candidates/[id]
//   { action: 'contacted', channel?: 'whatsapp'|'email'|'page', lang?: 'fr'|'en' }
//      the admin sent the permission request (from their own phone / mail)
//   { action: 'ignore', reason: 'not_relevant'|'duplicate'|'past'|'other' }
// Publishing goes through POST /api/admin/events with candidate_id.
// A published, ignored or deleted candidate can't be changed. Audited.
// super_admin | admin.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionFromRequest(req)
  if (!session || !['super_admin', 'admin'].includes(session.role)) {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }
  if (!/^[0-9a-f-]{36}$/i.test(params.id)) return NextResponse.json({ error: 'Introuvable / Not found' }, { status: 404 })
  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  const now = new Date().toISOString()

  const { data: cand } = await supabaseAdmin.from('event_candidates').select('id, title, city, start_date, status')
    .eq('id', params.id).is('deleted_at', null).maybeSingle()
  if (!cand) return NextResponse.json({ error: 'Introuvable / Not found' }, { status: 404 })
  if (!['new', 'contacted'].includes(cand.status)) {
    return NextResponse.json({ error: 'Déjà traité / Already handled' }, { status: 409 })
  }

  let patch: Record<string, unknown>
  let action: string
  let metadata: Record<string, unknown> = { title: cand.title, city: cand.city, start_date: cand.start_date }
  if (body.action === 'contacted') {
    const channel = ['whatsapp', 'email', 'page'].includes(String(body.channel)) ? String(body.channel) : 'whatsapp'
    patch = { status: 'contacted', contacted_at: now, contacted_by: session.id }
    action = 'event_candidate_contacted'
    metadata = { ...metadata, channel, lang: body.lang === 'en' ? 'en' : 'fr' }
  } else if (body.action === 'ignore') {
    const reason = String(body.reason ?? '') as IgnoreReason
    if (!IGNORE_REASONS.includes(reason)) return NextResponse.json({ error: 'Motif requis / Reason required' }, { status: 400 })
    patch = { status: 'ignored', ignored_at: now, ignored_by: session.id, ignore_reason: reason }
    action = 'event_candidate_ignored'
    metadata = { ...metadata, reason }
  } else {
    return NextResponse.json({ error: 'action: contacted | ignore' }, { status: 400 })
  }

  const { data: updated, error } = await supabaseAdmin.from('event_candidates').update(patch)
    .eq('id', cand.id).in('status', ['new', 'contacted']).is('deleted_at', null).select('id, status')
  if (error) return NextResponse.json({ error: 'Erreur serveur / Server error' }, { status: 500 })
  if (!updated?.length) return NextResponse.json({ error: 'Déjà traité / Already handled' }, { status: 409 })

  await writeAudit({
    action, targetType: 'event_candidate', targetId: cand.id,
    performedBy: session.id, performedByType: session.role,
    previousData: { status: cand.status }, metadata,
  })
  return NextResponse.json({ ok: true, status: updated[0].status })
}
