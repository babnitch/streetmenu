import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'

export const dynamic = 'force-dynamic'

// PATCH /api/admin/events/[id]/feature — { featured: boolean }
// The admin pick for "À la une" on the Events page (events.is_featured).
// Several can be marked; the page shows the soonest upcoming one.
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionFromRequest(req)
  if (!session || !['super_admin', 'admin', 'moderator'].includes(session.role)) {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }
  const body = await req.json().catch(() => ({}))
  if (typeof body?.featured !== 'boolean') {
    return NextResponse.json({ error: 'featured: boolean' }, { status: 400 })
  }
  const { data, error } = await supabaseAdmin
    .from('events').update({ is_featured: body.featured }).eq('id', params.id).select('id, title').maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data) return NextResponse.json({ error: 'Événement introuvable / Event not found' }, { status: 404 })

  await writeAudit({
    action: body.featured ? 'event_featured' : 'event_unfeatured',
    targetType: 'event', targetId: params.id,
    performedBy: session.id, performedByType: session.role,
    metadata: { title: data.title },
  })
  return NextResponse.json({ ok: true, featured: body.featured })
}
