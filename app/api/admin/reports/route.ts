import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'

export const dynamic = 'force-dynamic'

// GET /api/admin/reports?status=pending|reviewed|action_taken|dismissed|all
// Lists every report (newest first) with a small preview of the reported
// content + the reporter's contact info (admin-only — never exposed to
// the reported party). Also returns the per-status counts so the tab
// can render a "🚩 Reports (N pending)" badge.
//
// Preview lookup is best-effort: a target that has since been deleted
// shows an empty preview rather than 404-ing the whole list.
export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req)
  if (!session || !['super_admin', 'admin', 'moderator'].includes(session.role)) {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }

  const status = req.nextUrl.searchParams.get('status') ?? 'all'

  let query = supabaseAdmin
    .from('reports')
    .select('id, reporter_id, target_type, target_id, reason, description, status, reviewed_by, reviewed_at, admin_notes, created_at')
    .order('created_at', { ascending: false })
    .limit(200)
  if (status !== 'all') query = query.eq('status', status)

  const { data: reports, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Hydrate reporter + target preview. Single grouped query per kind
  // keeps this cheap even at 200 rows.
  const reporterIds = Array.from(new Set((reports ?? []).map(r => r.reporter_id).filter(Boolean) as string[]))
  const restaurantIds = Array.from(new Set((reports ?? []).filter(r => r.target_type === 'restaurant').map(r => r.target_id)))
  const eventIds      = Array.from(new Set((reports ?? []).filter(r => r.target_type === 'event'     ).map(r => r.target_id)))
  const commentIds    = Array.from(new Set((reports ?? []).filter(r => r.target_type === 'comment'   ).map(r => r.target_id)))

  const [
    reporters,
    restaurants,
    events,
    comments,
  ] = await Promise.all([
    reporterIds.length ? supabaseAdmin.from('customers').select('id, name, phone').in('id', reporterIds) : Promise.resolve({ data: [] as Array<{ id: string; name: string; phone: string }> }),
    restaurantIds.length ? supabaseAdmin.from('restaurants').select('id, name, city').in('id', restaurantIds) : Promise.resolve({ data: [] as Array<{ id: string; name: string; city: string }> }),
    eventIds.length      ? supabaseAdmin.from('events').select('id, title, city').in('id', eventIds)         : Promise.resolve({ data: [] as Array<{ id: string; title: string; city: string }> }),
    commentIds.length    ? supabaseAdmin.from('event_comments').select('id, comment, event_id, is_deleted').in('id', commentIds) : Promise.resolve({ data: [] as Array<{ id: string; comment: string; event_id: string; is_deleted: boolean }> }),
  ])

  const reporterMap = new Map((reporters.data ?? []).map(r => [r.id, r]))
  const restMap     = new Map((restaurants.data ?? []).map(r => [r.id, r]))
  const eventMap    = new Map((events.data ?? []).map(e => [e.id, e]))
  const commentMap  = new Map((comments.data ?? []).map(c => [c.id, c]))

  const hydrated = (reports ?? []).map(r => {
    let preview = ''
    let target_label = ''
    if (r.target_type === 'restaurant') {
      const x = restMap.get(r.target_id)
      target_label = x ? `${x.name}${x.city ? ` · ${x.city}` : ''}` : '— (supprimé)'
    } else if (r.target_type === 'event') {
      const x = eventMap.get(r.target_id)
      target_label = x ? `${x.title}${x.city ? ` · ${x.city}` : ''}` : '— (supprimé)'
    } else {
      const x = commentMap.get(r.target_id)
      target_label = x ? `Commentaire sur événement ${x.event_id.slice(-4).toUpperCase()}${x.is_deleted ? ' (déjà supprimé)' : ''}` : '— (supprimé)'
      preview = x?.comment ?? ''
    }
    return {
      ...r,
      target_label,
      preview,
      reporter: reporterMap.get(r.reporter_id) ?? null,
    }
  })

  // Counts per status — one query, all rows. Keeps the badge accurate
  // even when filtered.
  const { data: countsRaw } = await supabaseAdmin
    .from('reports').select('status')
  const counts: Record<string, number> = { pending: 0, reviewed: 0, action_taken: 0, dismissed: 0 }
  for (const c of countsRaw ?? []) counts[c.status] = (counts[c.status] ?? 0) + 1

  return NextResponse.json({ reports: hydrated, counts })
}
