import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'

export const dynamic = 'force-dynamic'

const CITIES = ['Yaoundé', 'Abidjan', 'Dakar', 'Lomé']

// POST { name?, city? } — update editable profile fields for the current
// customer. Phone is NEVER updatable here (it's the account identifier).
export async function POST(req: NextRequest) {
  const session = getSessionFromRequest(req)
  if (!session || session.role !== 'customer') {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }

  const body = await req.json()
  const patch: { name?: string; city?: string } = {}

  if (typeof body.name === 'string') {
    const trimmed = body.name.trim()
    if (!trimmed) {
      return NextResponse.json({ error: 'Nom requis / Name required' }, { status: 400 })
    }
    patch.name = trimmed
  }

  if (typeof body.city === 'string') {
    if (!CITIES.includes(body.city)) {
      return NextResponse.json({ error: 'Ville invalide / Invalid city' }, { status: 400 })
    }
    patch.city = body.city
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'Aucun changement / No changes' }, { status: 400 })
  }

  const { data, error } = await supabaseAdmin
    .from('customers')
    .update(patch)
    .eq('id', session.id)
    .select('id, name, phone, city, status, created_at, deleted_at')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data)  return NextResponse.json({ error: 'Profil introuvable / Profile not found' }, { status: 404 })

  return NextResponse.json({ ok: true, profile: data })
}
