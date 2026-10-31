import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'

export const dynamic = 'force-dynamic'

// DELETE /api/admin/featured/[id] — remove an "À la une" pick (soft delete:
// deleted_at + deleted_by, audited). Admin / super_admin.
export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const s = getSessionFromRequest(req)
  if (!s || !['super_admin', 'admin'].includes(s.role)) return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  const { data, error } = await supabaseAdmin.from('home_featured')
    .update({ deleted_at: new Date().toISOString(), deleted_by: s.id })
    .eq('id', params.id).is('deleted_at', null)
    .select('id, city, item_type, item_id, starts_on, ends_on').maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data) return NextResponse.json({ error: 'Introuvable / Not found' }, { status: 404 })
  await writeAudit({
    action: 'home_featured_removed', targetType: 'home_featured', targetId: params.id,
    performedBy: s.id, performedByType: s.role, metadata: data,
  })
  return NextResponse.json({ ok: true })
}
