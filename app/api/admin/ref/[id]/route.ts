import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'
import { invalidateRefData } from '@/lib/refDataServer'
import { REF_COLUMNS, checkFields, type RefRow } from '@/lib/refAdmin'

export const dynamic = 'force-dynamic'

// PATCH /api/admin/ref/[id] — edit a value (labels, icon, keywords, city
// centre, visible) or move it: { move: 'up' | 'down' } swaps it with its
// neighbour. The code never changes (rows store it). Admin + super admin.
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const s = getSessionFromRequest(req)
  if (!s || !['super_admin', 'admin'].includes(s.role)) return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  const { data: before } = await supabaseAdmin.from('ref_values').select(REF_COLUMNS).eq('id', params.id).maybeSingle()
  if (!before) return NextResponse.json({ error: 'Introuvable / Not found' }, { status: 404 })
  const row = before as RefRow
  const body = await req.json().catch(() => ({})) as Record<string, unknown>

  if (body.move === 'up' || body.move === 'down') {
    const up = body.move === 'up'
    const { data: nb } = await supabaseAdmin.from('ref_values').select('id, sort_order').eq('kind', row.kind)
      [up ? 'lt' : 'gt']('sort_order', row.sort_order).order('sort_order', { ascending: !up }).limit(1)
    const n = nb?.[0] as { id: string; sort_order: number } | undefined
    if (n) {
      await supabaseAdmin.from('ref_values').update({ sort_order: n.sort_order, updated_at: new Date().toISOString() }).eq('id', row.id)
      await supabaseAdmin.from('ref_values').update({ sort_order: row.sort_order, updated_at: new Date().toISOString() }).eq('id', n.id)
      invalidateRefData()
      await writeAudit({ action: 'ref_value_moved', targetType: 'platform', targetId: row.id, performedBy: s.id, performedByType: s.role, metadata: { kind: row.kind, code: row.code, move: body.move } })
    }
    return NextResponse.json({ ok: true })
  }

  const v = checkFields(body, row.kind, false)
  if (!v.ok) return NextResponse.json({ error: v.error, field: v.field }, { status: 400 })
  if (!Object.keys(v.fields).length) return NextResponse.json({ ok: true, value: row })
  const { data, error } = await supabaseAdmin.from('ref_values').update({ ...v.fields, updated_at: new Date().toISOString() })
    .eq('id', row.id).select(REF_COLUMNS).single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  invalidateRefData()
  const changed = Object.keys(v.fields).filter(k => JSON.stringify((row as unknown as Record<string, unknown>)[k]) !== JSON.stringify((v.fields as Record<string, unknown>)[k]))
  await writeAudit({
    action: 'visible' in v.fields && v.fields.visible !== row.visible ? (v.fields.visible ? 'ref_value_shown' : 'ref_value_hidden') : 'ref_value_updated',
    targetType: 'platform', targetId: row.id, performedBy: s.id, performedByType: s.role,
    previousData: Object.fromEntries(changed.map(k => [k, (row as unknown as Record<string, unknown>)[k]])), metadata: { kind: row.kind, code: row.code, changed },
  })
  return NextResponse.json({ ok: true, value: data })
}
