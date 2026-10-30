import { NextRequest, NextResponse } from 'next/server'
import { chooseCity, chooseCategory, recordProposal } from '@/lib/refChoice'
import { getRefData } from '@/lib/refDataServer'
import { picturesFirst, hasPicture } from '@/lib/popularRanking'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { rateLimit } from '@/lib/rateLimit'
import { writeAudit } from '@/lib/audit'
import { PUBLIC_PLACE_COLUMNS, validatePlace } from '@/lib/places'

export const dynamic = 'force-dynamic'

// /api/places (I4)
// GET  ?city=…[&limit=n]  the city's published places — public fields only
//      (never the admin note, the sources or who proposed it)
// POST a proposal from any logged-in user ("+ Ajouter → Un lieu à
//      visiter", either mode): pending until an admin publishes it; a photo
//      is optional (the generated cover shows). 5 a day per account.
export async function GET(req: NextRequest) {
  await getRefData()
  const city = req.nextUrl.searchParams.get('city') ?? ''
  const limit = Math.min(100, Math.max(1, Number(req.nextUrl.searchParams.get('limit') ?? 100) || 100))
  if (!city) return NextResponse.json({ error: 'city' }, { status: 400 })
  // ?pictures_first=1 (the home row): places with a photo first, then the
  // generated covers, alphabetical inside each — before the limit, so the
  // row is filled photo-first. The /lieux page keeps the plain A–Z order.
  const picturesFirstParam = req.nextUrl.searchParams.get('pictures_first') === '1'
  const { data, error } = await supabaseAdmin.from('places').select(PUBLIC_PLACE_COLUMNS)
    .eq('city', city).eq('status', 'active').order('title_fr').limit(picturesFirstParam ? 100 : limit)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  const places = picturesFirstParam
    ? picturesFirst((data ?? []) as unknown as Array<{ cover_url: string | null }>, p => (hasPicture(p.cover_url) ? 0 : 1)).slice(0, limit)
    : (data ?? [])
  return NextResponse.json({ places }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(req: NextRequest) {
  await getRefData()
  const session = getSessionFromRequest(req)
  if (!session || session.role !== 'customer') return NextResponse.json({ error: 'Connexion requise / Login required' }, { status: 401 })
  const hit = rateLimit({ key: `place:propose:${session.id}`, max: 5, windowMs: 86_400_000 })
  if (hit) return NextResponse.json({ error: hit.message }, { status: 429 })
  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  // A proposal sets the visible fields only; status / notes are the admin's.
  // City / category: a listed value, or "Autre…" (a proposal; the place is
  // pending anyway, so a proposed city is never live by itself).
  const cityPick = chooseCity(body.city, body.city_other)
  if (!cityPick.ok) return NextResponse.json({ error: cityPick.error, field: 'city' }, { status: 400 })
  const catPick = chooseCategory('place_category', body.category, body.category_other)
  if (!catPick.ok) return NextResponse.json({ error: catPick.error, field: 'category' }, { status: 400 })
  body.city = cityPick.city
  body.category = catPick.category
  const allowed = ['city', 'area', 'category', 'title_fr', 'description_fr', 'tip_fr', 'hours', 'price', 'official_link', 'instagram_url', 'facebook_url', 'tiktok_url', 'cover_url']
  const v = validatePlace(Object.fromEntries(allowed.filter(k => k in body).map(k => [k, body[k]])), true)
  if (!v.ok) return NextResponse.json({ error: v.error, field: v.field }, { status: 400 })
  const { data, error } = await supabaseAdmin.from('places')
    .insert({ ...v.place, status: 'pending', managed_by_platform: true, submitted_by: session.id })
    .select('id').single()
  if (error) {
    const dup = /duplicate|unique/i.test(error.message)
    return NextResponse.json({ error: dup ? 'Ce lieu existe déjà / This place already exists' : error.message }, { status: dup ? 409 : 500 })
  }
  if (cityPick.proposed) await recordProposal({ kind: 'city', proposed: cityPick.proposed, by: session.id, targetType: 'place', targetId: data.id as string, savedAs: cityPick.city })
  if (catPick.proposed) await recordProposal({ kind: 'place_category', proposed: catPick.proposed, by: session.id, targetType: 'place', targetId: data.id as string, savedAs: catPick.category })
  await writeAudit({ action: 'place_proposed', targetType: 'place', targetId: data.id as string, performedBy: session.id, performedByType: 'customer', metadata: { title: v.place.title_fr, city: v.place.city } })
  return NextResponse.json({ ok: true, id: data.id })
}
