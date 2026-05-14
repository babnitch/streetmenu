import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'

export const dynamic = 'force-dynamic'

// GET /api/restaurants/[id]/hours
// Public read — schedule appears on the restaurant detail page.
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const { data, error } = await supabaseAdmin
    .from('restaurant_hours')
    .select('day_of_week, open_time, close_time, is_closed')
    .eq('restaurant_id', params.id)
    .order('day_of_week', { ascending: true })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ hours: data ?? [] })
}

// POST /api/restaurants/[id]/hours
// Body: { hours: [{ day_of_week, open_time, close_time, is_closed }, … ] }
//
// Owner-only (manager/staff intentionally excluded — schedule is a
// commercial decision). Replaces the whole week in one upsert so the
// client doesn't have to track which days exist server-side.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionFromRequest(req)
  if (!session) return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  const isAdmin = ['super_admin', 'admin', 'moderator'].includes(session.role)

  if (!isAdmin) {
    // Direct ownership or owner via team. Manager + staff aren't allowed
    // to change opening hours.
    const { data: r } = await supabaseAdmin
      .from('restaurants').select('id').eq('id', params.id).eq('customer_id', session.id).maybeSingle()
    if (!r) {
      const { data: team } = await supabaseAdmin
        .from('restaurant_team').select('role')
        .eq('restaurant_id', params.id).eq('customer_id', session.id)
        .eq('status', 'active').eq('role', 'owner').maybeSingle()
      if (!team) return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 403 })
    }
  }

  const body = await req.json().catch(() => ({}))
  const incoming = Array.isArray(body?.hours) ? body.hours : []
  // Normalise + validate. Anything malformed is dropped silently so a
  // partial save doesn't 500 the whole batch.
  const rows: Array<{ restaurant_id: string; day_of_week: number; open_time: string; close_time: string; is_closed: boolean }> = []
  for (const h of incoming) {
    const dow = Number(h?.day_of_week)
    if (!Number.isInteger(dow) || dow < 0 || dow > 6) continue
    const open  = String(h?.open_time  ?? '08:00').slice(0, 5)
    const close = String(h?.close_time ?? '22:00').slice(0, 5)
    if (!/^\d{2}:\d{2}$/.test(open) || !/^\d{2}:\d{2}$/.test(close)) continue
    rows.push({
      restaurant_id: params.id,
      day_of_week:   dow,
      open_time:     open,
      close_time:    close,
      is_closed:     !!h?.is_closed,
    })
  }
  if (rows.length === 0) return NextResponse.json({ error: 'No valid rows' }, { status: 400 })

  // Single upsert keyed by the UNIQUE(restaurant_id, day_of_week) constraint.
  const { error } = await supabaseAdmin
    .from('restaurant_hours')
    .upsert(rows, { onConflict: 'restaurant_id,day_of_week' })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await writeAudit({
    action:          'schedule_updated',
    targetType:      'restaurant',
    targetId:        params.id,
    performedBy:     session.id,
    performedByType: isAdmin ? session.role : 'vendor',
    metadata:        { days: rows.length },
  })

  return NextResponse.json({ ok: true })
}
