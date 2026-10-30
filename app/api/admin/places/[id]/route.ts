import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'
import { validatePlace } from '@/lib/places'

export const dynamic = 'force-dynamic'

// PATCH /api/admin/places/[id] (I4) — edit any field, publish (status
// active), hide, approve a proposal. Admin / super_admin; audited.
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const s = getSessionFromRequest(req)
  if (!s || !['super_admin', 'admin'].includes(s.role)) return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  const v = validatePlace(await req.json().catch(() => ({})), false)
  if (!v.ok) return NextResponse.json({ error: v.error, field: v.field }, { status: 400 })
  const { data: before } = await supabaseAdmin.from('places').select('status').eq('id', params.id).maybeSingle()
  if (!before) return NextResponse.json({ error: 'Introuvable / Not found' }, { status: 404 })
  const { data, error } = await supabaseAdmin.from('places')
    .update({ ...v.place, updated_at: new Date().toISOString() }).eq('id', params.id).select('*').single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  await writeAudit({
    action: v.place.status && v.place.status !== before.status ? `place_${v.place.status}` : 'place_updated',
    targetType: 'place', targetId: params.id, performedBy: s.id, performedByType: s.role,
    previousData: { status: before.status }, metadata: { fields: Object.keys(v.place) },
  })
  return NextResponse.json({ ok: true, place: data })
}
