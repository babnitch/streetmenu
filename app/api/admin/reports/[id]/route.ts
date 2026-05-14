import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'

export const dynamic = 'force-dynamic'

// PATCH /api/admin/reports/[id]
// Body: { status?: 'reviewed' | 'action_taken' | 'dismissed', admin_notes?: string, delete_content?: boolean }
//
// Single endpoint for the four admin actions the spec asks for:
//   - Dismiss        → status='dismissed'
//   - Mark reviewed  → status='reviewed' (no content change)
//   - Delete content → soft-delete the targeted comment (other target
//     types must be moderated via the existing suspend routes) AND mark
//     status='action_taken'
//   - Save notes     → admin_notes only, status untouched
//
// Restaurant + customer suspension happen via the existing admin routes
// (/api/restaurants/[id]/suspend, /api/accounts/[id]/suspend). We don't
// re-implement them here — the report panel deep-links to them.
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionFromRequest(req)
  if (!session || !['super_admin', 'admin', 'moderator'].includes(session.role)) {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }

  const body = await req.json().catch(() => ({}))
  const wantsDeleteContent = !!body?.delete_content
  const rawStatus: unknown = body?.status
  const adminNotes = typeof body?.admin_notes === 'string' ? body.admin_notes.trim().slice(0, 1000) : null

  const validStatus = rawStatus === 'reviewed' || rawStatus === 'action_taken' || rawStatus === 'dismissed' || rawStatus == null
  if (!validStatus) {
    return NextResponse.json({ error: 'status invalide / invalid' }, { status: 400 })
  }

  const { data: report } = await supabaseAdmin
    .from('reports')
    .select('id, target_type, target_id, status')
    .eq('id', params.id).maybeSingle()
  if (!report) return NextResponse.json({ error: 'Signalement introuvable / Report not found' }, { status: 404 })

  // Content deletion is only meaningful for comments at this layer. The
  // existing comment DELETE route (/api/events/[eventId]/comments/[id])
  // handles the actual soft-delete; we replicate the same write here so
  // we don't need to thread the event_id through the client.
  let deleted = false
  if (wantsDeleteContent && report.target_type === 'comment') {
    const { data: c } = await supabaseAdmin
      .from('event_comments')
      .select('id, is_deleted')
      .eq('id', report.target_id).maybeSingle()
    if (c && !c.is_deleted) {
      await supabaseAdmin
        .from('event_comments')
        .update({ is_deleted: true, deleted_by: session.id, deleted_at: new Date().toISOString() })
        .eq('id', c.id)
      deleted = true
      await writeAudit({
        action:          'comment_deleted',
        targetType:      'event',
        targetId:        c.id,
        performedBy:     session.id,
        performedByType: session.role,
        metadata:        { via: 'report_action', report_id: report.id },
      })
    }
  }

  // Decide the new status. If content was deleted and no explicit status
  // was passed, default to 'action_taken' so the report card stops nagging.
  const nextStatus =
    rawStatus ??
    (deleted ? 'action_taken' : report.status)

  const updateRow: Record<string, unknown> = { admin_notes: adminNotes ?? null }
  if (nextStatus !== report.status) {
    updateRow.status      = nextStatus
    updateRow.reviewed_by = session.id
    updateRow.reviewed_at = new Date().toISOString()
  }

  const { error: updErr } = await supabaseAdmin
    .from('reports').update(updateRow).eq('id', params.id)
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 })

  await writeAudit({
    action:          nextStatus === 'action_taken' ? 'report_action_taken' : 'report_reviewed',
    targetType:      'report',
    targetId:        report.id,
    performedBy:     session.id,
    performedByType: session.role,
    previousData:    { status: report.status },
    metadata:        { new_status: nextStatus, deleted_content: deleted, target_type: report.target_type, target_id: report.target_id },
  })

  return NextResponse.json({ ok: true, status: nextStatus, deleted })
}
