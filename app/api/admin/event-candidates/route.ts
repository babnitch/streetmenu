import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { CANDIDATE_COLUMNS } from '@/lib/discovery/candidates'

export const dynamic = 'force-dynamic'

// GET /api/admin/event-candidates — "Trouvés cette nuit": found events still
// waiting for a decision (new or contacted, not deleted), soonest first.
// Admin / super_admin / moderator (moderators look, admins act).
export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req)
  if (!session || !['super_admin', 'admin', 'moderator'].includes(session.role)) {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }
  const { data, error } = await supabaseAdmin.from('event_candidates').select(CANDIDATE_COLUMNS)
    .in('status', ['new', 'contacted']).is('deleted_at', null)
    .order('start_date', { ascending: true }).range(0, 499)
  if (error) {
    // Before supabase-event-discovery.sql: an empty list, not an error page.
    console.error('[admin/event-candidates] query failed:', error.message)
    return NextResponse.json({ candidates: [] })
  }
  const dupIds = Array.from(new Set((data ?? []).map(c => c.possible_duplicate_event_id).filter(Boolean))) as string[]
  const titles: Record<string, string> = {}
  if (dupIds.length) {
    const { data: evs } = await supabaseAdmin.from('events').select('id, title').in('id', dupIds)
    for (const e of evs ?? []) titles[e.id] = e.title
  }
  return NextResponse.json({
    candidates: (data ?? []).map(c => ({ ...c, possible_duplicate_title: c.possible_duplicate_event_id ? titles[c.possible_duplicate_event_id] ?? null : null })),
  })
}
