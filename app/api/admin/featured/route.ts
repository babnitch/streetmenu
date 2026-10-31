import { NextRequest, NextResponse } from 'next/server'
import { getRefData } from '@/lib/refDataServer'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'
import { todayInDouala } from '@/lib/weekend'
import { EVENT_DATE_COLUMNS, isFinishedEvent } from '@/lib/eventDate'
import { hasPicture } from '@/lib/popularRanking'
import { validateFeaturedInput, FEATURED_TYPES, type FeaturedType } from '@/lib/homeFeatured'
import { homeFeaturedCard, resolveFeaturedItem, featuredItemCity, type FeaturedPickRow } from '@/lib/homeFeaturedServer'

export const dynamic = 'force-dynamic'

// /api/admin/featured — Admin → À la une. Admin / super_admin.
// GET  ?city=X              the city's picks (not removed) + what the home shows now
// GET  ?city=X&q=…&type=…   search the city's live events, restaurants, places
// POST { city, item_type, item_id, starts_on, ends_on }   add a pick (audited)
// Remove: DELETE /api/admin/featured/[id] (soft delete).
function authorize(req: NextRequest) {
  const s = getSessionFromRequest(req)
  return s && ['super_admin', 'admin'].includes(s.role) ? s : null
}

const NOT_AVAILABLE = 'À la une pas encore disponible (SQL) / Featured not available yet (SQL)'

export async function GET(req: NextRequest) {
  await getRefData()
  if (!authorize(req)) return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  const city = req.nextUrl.searchParams.get('city') ?? ''
  if (!city) return NextResponse.json({ error: 'city' }, { status: 400 })
  const q = (req.nextUrl.searchParams.get('q') ?? '').trim()
  if (q) return NextResponse.json({ results: await search(city, q, req.nextUrl.searchParams.get('type')) }, { headers: { 'Cache-Control': 'no-store' } })

  const today = todayInDouala()
  const [picksRes, current] = await Promise.all([
    supabaseAdmin.from('home_featured').select('id, city, item_type, item_id, starts_on, ends_on, created_at')
      .eq('city', city).is('deleted_at', null).order('starts_on', { ascending: false }).limit(50),
    homeFeaturedCard(city),
  ])
  if (picksRes.error) return NextResponse.json({ available: false, picks: [], current }, { headers: { 'Cache-Control': 'no-store' } })
  const picks = await Promise.all(((picksRes.data ?? []) as FeaturedPickRow[]).map(async p => {
    const card = await resolveFeaturedItem(p.item_type, p.item_id, { today })
    return {
      ...p,
      name: card?.title_fr ?? await itemName(p.item_type, p.item_id),
      live: !!card, has_photo: !!card?.image,
      state: p.ends_on < today ? 'ended' : p.starts_on > today ? 'upcoming' : 'running',
    }
  }))
  return NextResponse.json({ available: true, picks, current }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(req: NextRequest) {
  await getRefData()
  const s = authorize(req)
  if (!s) return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  const v = validateFeaturedInput(await req.json().catch(() => null), todayInDouala())
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 })
  const { city, item_type, item_id } = v.value
  if ((await featuredItemCity(item_type, item_id)) !== city) {
    return NextResponse.json({ error: 'Élément introuvable dans cette ville / Item not found in this city' }, { status: 400 })
  }
  if (!(await resolveFeaturedItem(item_type, item_id))) {
    return NextResponse.json({ error: 'Élément pas en ligne (inactif ou terminé) / Item not live (inactive or over)' }, { status: 400 })
  }
  const { data, error } = await supabaseAdmin.from('home_featured')
    .insert({ ...v.value, created_by: s.id }).select('id').single()
  if (error) {
    const missing = /home_featured|schema cache|does not exist/i.test(error.message)
    return NextResponse.json({ error: missing ? NOT_AVAILABLE : error.message }, { status: missing ? 503 : 500 })
  }
  await writeAudit({
    action: 'home_featured_set', targetType: 'home_featured', targetId: data.id as string,
    performedBy: s.id, performedByType: s.role, metadata: { ...v.value },
  })
  return NextResponse.json({ ok: true, id: data.id })
}

async function itemName(type: FeaturedType, id: string): Promise<string> {
  const [table, col] = type === 'event' ? ['events', 'title'] : type === 'restaurant' ? ['restaurants', 'name'] : ['places', 'title_fr']
  const { data } = await supabaseAdmin.from(table).select(col).eq('id', id).maybeSingle()
  return String((data as Record<string, unknown> | null)?.[col] ?? '?')
}

interface SearchResult { type: FeaturedType; id: string; name: string; sub: string | null; has_photo: boolean }

// Live items only, so a pick can't be made on something the home would skip.
async function search(city: string, q: string, typeParam: string | null): Promise<SearchResult[]> {
  const like = `%${q.replace(/[%_\\]/g, m => `\\${m}`)}%`
  const types = FEATURED_TYPES.filter(t => !typeParam || t === typeParam)
  const today = todayInDouala()
  const out: SearchResult[] = []
  if (types.includes('event')) {
    const { data } = await supabaseAdmin.from('events').select(`id, title, venue, cover_photo, event_status, ${EVENT_DATE_COLUMNS}`)
      .eq('city', city).eq('is_active', true).ilike('title', like).limit(30)
    for (const e of (data ?? []) as unknown as Array<{ id: string; title: string; venue: string | null; cover_photo: string | null; event_status: string | null; date: string | null; end_date: string | null }>) {
      if (e.event_status === 'cancelled' || isFinishedEvent(e, today)) continue
      out.push({ type: 'event', id: e.id, name: e.title, sub: [e.date, e.venue].filter(Boolean).join(' · ') || null, has_photo: hasPicture(e.cover_photo) })
    }
  }
  if (types.includes('restaurant')) {
    const { data } = await supabaseAdmin.from('restaurants').select('id, name, neighborhood, image_url, logo_url')
      .eq('city', city).eq('is_active', true).in('status', ['active', 'approved']).is('deleted_at', null).ilike('name', like).limit(10)
    for (const r of data ?? []) out.push({ type: 'restaurant', id: r.id, name: r.name, sub: r.neighborhood, has_photo: hasPicture(r.image_url) || hasPicture(r.logo_url) })
  }
  if (types.includes('place')) {
    const { data } = await supabaseAdmin.from('places').select('id, title_fr, area, cover_url')
      .eq('city', city).eq('status', 'active').ilike('title_fr', like).limit(10)
    for (const p of data ?? []) out.push({ type: 'place', id: p.id, name: p.title_fr, sub: p.area, has_photo: hasPicture(p.cover_url) })
  }
  return out.slice(0, 30)
}
