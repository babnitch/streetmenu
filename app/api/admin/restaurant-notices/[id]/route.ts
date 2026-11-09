import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'

export const dynamic = 'force-dynamic'

// POST /api/admin/restaurant-notices/[id]  { action: 'seen' } — an admin has
// looked at an owner's change: it leaves the list (kept, never deleted).
// Audited. super_admin | admin | moderator.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionFromRequest(req)
  if (!session || !['super_admin', 'admin', 'moderator'].includes(session.role)) {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }
  const body = await req.json().catch(() => ({})) as { action?: string }
  if (body.action !== 'seen') return NextResponse.json({ error: 'action: seen' }, { status: 400 })
  if (!/^[0-9a-f-]{36}$/i.test(params.id)) return NextResponse.json({ error: 'Introuvable / Not found' }, { status: 404 })
  const { data, error } = await supabaseAdmin.from('restaurant_change_notices')
    .update({ seen_at: new Date().toISOString(), seen_by: session.id })
    .eq('id', params.id).is('seen_at', null).is('deleted_at', null).select('id, restaurant_id')
  if (error) return NextResponse.json({ error: 'Erreur serveur / Server error' }, { status: 500 })
  if (!data?.length) return NextResponse.json({ error: 'Introuvable ou déjà vu / Not found or already seen' }, { status: 404 })
  await writeAudit({
    action: 'restaurant_change_notice_seen', targetType: 'restaurant', targetId: data[0].restaurant_id,
    performedBy: session.id, performedByType: session.role, metadata: { notice_id: params.id },
  })
  return NextResponse.json({ ok: true })
}
