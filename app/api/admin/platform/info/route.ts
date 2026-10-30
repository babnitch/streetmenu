import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromRequest } from '@/lib/auth'
import { getLegalInfo, setLegalInfo } from '@/lib/legalInfoServer'

export const dynamic = 'force-dynamic'

// /api/admin/platform/info (U1) — Admin → Plateforme → "Infos légales et
// contact". GET the values, PUT them all (empty = hidden). Super admin
// only; audited.
function authorize(req: NextRequest) {
  const s = getSessionFromRequest(req)
  return s && s.role === 'super_admin' ? s : null
}

export async function GET(req: NextRequest) {
  if (!authorize(req)) return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  return NextResponse.json(await getLegalInfo(), { headers: { 'Cache-Control': 'no-store' } })
}

export async function PUT(req: NextRequest) {
  const s = authorize(req)
  if (!s) return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  const r = await setLegalInfo(await req.json().catch(() => ({})), { id: s.id, type: s.role })
  if (!r.ok) return NextResponse.json({ error: r.error, field: r.field }, { status: 400 })
  return NextResponse.json({ ok: true, info: r.info })
}
