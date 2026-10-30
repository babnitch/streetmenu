import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'
import { validatePlace } from '@/lib/places'

export const dynamic = 'force-dynamic'

// /api/admin/places (I4) — Admin → Lieux.
// GET  every place (all statuses, with admin note, sources, who proposed)
// POST create (published or hidden, admin's choice). Admin / super_admin.
function authorize(req: NextRequest) {
  const s = getSessionFromRequest(req)
  return s && ['super_admin', 'admin'].includes(s.role) ? s : null
}

export async function GET(req: NextRequest) {
  if (!authorize(req)) return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  const { data, error } = await supabaseAdmin.from('places')
    .select('*, submitter:customers!places_submitted_by_fkey(name, phone)')
    .order('created_at', { ascending: false }).range(0, 999)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ places: data ?? [] }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(req: NextRequest) {
  const s = authorize(req)
  if (!s) return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  const v = validatePlace(await req.json().catch(() => ({})), true)
  if (!v.ok) return NextResponse.json({ error: v.error, field: v.field }, { status: 400 })
  const { data, error } = await supabaseAdmin.from('places')
    .insert({ status: 'active', ...v.place, managed_by_platform: true }).select('*').single()
  if (error) {
    const dup = /duplicate|unique/i.test(error.message)
    return NextResponse.json({ error: dup ? 'Ce lieu existe déjà / This place already exists' : error.message }, { status: dup ? 409 : 500 })
  }
  await writeAudit({ action: 'place_created_by_admin', targetType: 'place', targetId: data.id as string, performedBy: s.id, performedByType: s.role, metadata: { title: data.title_fr, status: data.status } })
  return NextResponse.json({ ok: true, place: data })
}
