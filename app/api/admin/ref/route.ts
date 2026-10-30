import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'
import { getRefData, invalidateRefData } from '@/lib/refDataServer'
import { REF_COLUMNS, checkFields, codeFor, isRefKind, usageCounts, type RefRow } from '@/lib/refAdmin'

export const dynamic = 'force-dynamic'

// /api/admin/ref — Admin → Données de référence (admin + super admin).
// GET   every value (hidden too) with "used by N"
// POST  { kind, label_fr, label_en, icon?, keywords?, country?, lat?, lng?, zoom?, visible? }
//       add a value (code derived from the label; never deleted, only hidden)
function authorize(req: NextRequest) {
  const s = getSessionFromRequest(req)
  return s && ['super_admin', 'admin'].includes(s.role) ? s : null
}

export async function GET(req: NextRequest) {
  if (!authorize(req)) return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  await getRefData(true)
  const { data, error } = await supabaseAdmin.from('ref_values').select(REF_COLUMNS).order('kind').order('sort_order')
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  const rows = (data ?? []) as RefRow[]
  const usage = await usageCounts(rows)
  return NextResponse.json({ values: rows.map(r => ({ ...r, usage: usage[r.id] ?? { total: 0, detail: {} } })) }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(req: NextRequest) {
  const s = authorize(req)
  if (!s) return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  if (!isRefKind(body.kind)) return NextResponse.json({ error: 'Liste inconnue / Unknown list', field: 'kind' }, { status: 400 })
  const v = checkFields(body, body.kind, true)
  if (!v.ok) return NextResponse.json({ error: v.error, field: v.field }, { status: 400 })
  const code = codeFor(body.kind, v.fields.label_fr!)
  if (!code) return NextResponse.json({ error: 'Libellé FR invalide / Invalid FR label', field: 'label_fr' }, { status: 400 })
  const { data: last } = await supabaseAdmin.from('ref_values').select('sort_order').eq('kind', body.kind).lt('sort_order', 999).order('sort_order', { ascending: false }).limit(1)
  const { data, error } = await supabaseAdmin.from('ref_values').insert({
    kind: body.kind, code, visible: true, sort_order: ((last?.[0]?.sort_order as number | undefined) ?? 0) + 10, ...v.fields,
  }).select(REF_COLUMNS).single()
  if (error) {
    const dup = /duplicate|unique/i.test(error.message)
    return NextResponse.json({ error: dup ? 'Cette valeur existe déjà / This value already exists' : error.message, field: 'label_fr' }, { status: dup ? 409 : 500 })
  }
  invalidateRefData()
  await writeAudit({ action: 'ref_value_created', targetType: 'platform', targetId: data.id, performedBy: s.id, performedByType: s.role, metadata: { kind: body.kind, code, label_fr: data.label_fr } })
  return NextResponse.json({ ok: true, value: data })
}
