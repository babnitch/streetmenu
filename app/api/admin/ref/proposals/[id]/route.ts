import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'
import { getRefData, invalidateRefData } from '@/lib/refDataServer'
import { refFind } from '@/lib/refData'
import { REF_COLUMNS, checkFields, codeFor } from '@/lib/refAdmin'
import { applyToTarget, type ProposalRow } from '@/lib/refProposals'

export const dynamic = 'force-dynamic'

// POST /api/admin/ref/proposals/[id] — resolve a proposal (admin + super admin):
//   { action: 'accept', label_fr, label_en, icon?, keywords?, country?, lat?, lng? }
//       adds the value (visible) — or reuses it when it already exists — and
//       sets it on the item
//   { action: 'map', code }   sets an existing value on the item
//   { action: 'reject' }      the item keeps what it was saved with
// Once only (a resolved proposal → 409). Audited.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const s = getSessionFromRequest(req)
  if (!s || !['super_admin', 'admin'].includes(s.role)) return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  const { data: row } = await supabaseAdmin.from('ref_proposals').select('*').eq('id', params.id).maybeSingle()
  if (!row) return NextResponse.json({ error: 'Introuvable / Not found' }, { status: 404 })
  const p = row as ProposalRow
  if (p.status !== 'pending') return NextResponse.json({ error: 'Déjà traitée / Already handled' }, { status: 409 })
  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  await getRefData(true)

  let status: 'accepted' | 'mapped' | 'rejected'
  let code: string | null = null
  if (body.action === 'reject') {
    status = 'rejected'
  } else if (body.action === 'map') {
    const v = refFind(p.kind, String(body.code ?? ''))
    if (!v) return NextResponse.json({ error: 'Valeur inconnue / Unknown value', field: 'code' }, { status: 400 })
    status = 'mapped'; code = v.code
  } else if (body.action === 'accept') {
    const f = checkFields({ label_fr: p.proposed, label_en: p.proposed, ...body }, p.kind, true)
    if (!f.ok) return NextResponse.json({ error: f.error, field: f.field }, { status: 400 })
    const newCode = codeFor(p.kind, f.fields.label_fr!)
    const existing = refFind(p.kind, newCode)
    if (existing) {
      code = existing.code
      if (!existing.visible) await supabaseAdmin.from('ref_values').update({ visible: true, updated_at: new Date().toISOString() }).eq('kind', p.kind).eq('code', existing.code)
    } else {
      const { data: last } = await supabaseAdmin.from('ref_values').select('sort_order').eq('kind', p.kind).lt('sort_order', 999).order('sort_order', { ascending: false }).limit(1)
      const { data: created, error } = await supabaseAdmin.from('ref_values').insert({
        kind: p.kind, code: newCode, visible: true, sort_order: ((last?.[0]?.sort_order as number | undefined) ?? 0) + 10, ...f.fields,
      }).select(REF_COLUMNS).single()
      if (error || !created) return NextResponse.json({ error: error?.message ?? 'Erreur' }, { status: 500 })
      await writeAudit({ action: 'ref_value_created', targetType: 'platform', targetId: created.id, performedBy: s.id, performedByType: s.role, metadata: { kind: p.kind, code: newCode, from_proposal: p.id } })
      code = newCode
    }
    invalidateRefData()
    await getRefData(true)
    status = 'accepted'
  } else {
    return NextResponse.json({ error: 'Action inconnue / Unknown action' }, { status: 400 })
  }

  if (code) {
    const err = await applyToTarget(p, code)
    if (err) return NextResponse.json({ error: err }, { status: 500 })
  }
  const { data: won } = await supabaseAdmin.from('ref_proposals')
    .update({ status, resolved_code: code, resolved_by: s.id, resolved_at: new Date().toISOString() })
    .eq('id', p.id).eq('status', 'pending').select('id').maybeSingle()
  if (!won) return NextResponse.json({ error: 'Déjà traitée / Already handled' }, { status: 409 })
  await writeAudit({
    action: `ref_proposal_${status}`, targetType: 'platform', targetId: p.id, performedBy: s.id, performedByType: s.role,
    metadata: { kind: p.kind, proposed: p.proposed, code, target_type: p.target_type, target_id: p.target_id, saved_as: p.saved_as },
  })
  return NextResponse.json({ ok: true, status, code })
}
