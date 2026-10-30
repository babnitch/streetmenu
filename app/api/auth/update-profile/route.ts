import { NextRequest, NextResponse } from 'next/server'
import { getRefData } from '@/lib/refDataServer'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'

export const dynamic = 'force-dynamic'

import { chooseCity, recordProposal } from '@/lib/refChoice'

// POST { name?, city? } — update editable profile fields for the current
// customer. Phone is NEVER updatable here (it's the account identifier).
export async function POST(req: NextRequest) {
  await getRefData()
  const session = getSessionFromRequest(req)
  if (!session || session.role !== 'customer') {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }

  const body = await req.json()
  const patch: { name?: string; city?: string | null } = {}

  if (typeof body.name === 'string') {
    const trimmed = body.name.trim()
    if (!trimmed) {
      return NextResponse.json({ error: 'Nom requis / Name required' }, { status: 400 })
    }
    patch.name = trimmed
  }

  // City: a listed one, or "Autre…" (a proposal; saved as typed).
  let proposedCity: string | null = null
  if (typeof body.city === 'string' || typeof body.city_other === 'string') {
    if (!body.city && !(typeof body.city_other === 'string' && body.city_other.trim())) {
      patch.city = null
    } else {
      const pick = chooseCity(body.city, body.city_other)
      if (!pick.ok) return NextResponse.json({ error: 'Ville invalide / Invalid city' }, { status: 400 })
      patch.city = pick.city
      proposedCity = pick.proposed
    }
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

  if (proposedCity) await recordProposal({ kind: 'city', proposed: proposedCity, by: session.id, targetType: 'customer', targetId: session.id, savedAs: String(patch.city) })
  return NextResponse.json({ ok: true, profile: data })
}
