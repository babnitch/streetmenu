import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'

export const dynamic = 'force-dynamic'

// DELETE /api/events/[id]/comments/[commentId]
// Admin/moderator soft-delete. Sets is_deleted=true + deleted_by +
// deleted_at so the comment vanishes from public listings but stays
// auditable. Returns 200 + ok=true even for an already-deleted row.
export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string; commentId: string } },
) {
  const session = getSessionFromRequest(req)
  if (!session || !['super_admin', 'admin', 'moderator'].includes(session.role)) {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }

  const { data: c } = await supabaseAdmin
    .from('event_comments')
    .select('id, is_deleted, event_id')
    .eq('id', params.commentId).eq('event_id', params.id).maybeSingle()
  if (!c) return NextResponse.json({ error: 'Commentaire introuvable / Comment not found' }, { status: 404 })
  if (c.is_deleted) return NextResponse.json({ ok: true, ignored: 'already deleted' })

  await supabaseAdmin
    .from('event_comments')
    .update({ is_deleted: true, deleted_by: session.id, deleted_at: new Date().toISOString() })
    .eq('id', params.commentId)

  await writeAudit({
    action:          'comment_deleted',
    targetType:      'event',
    targetId:        params.id,
    performedBy:     session.id,
    performedByType: session.role,
    metadata:        { comment_id: params.commentId },
  })

  return NextResponse.json({ ok: true })
}
