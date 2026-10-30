import { NextRequest, NextResponse } from 'next/server'
import { getRefData } from '@/lib/refDataServer'
import { chooseCity, chooseCuisine, recordProposal } from '@/lib/refChoice'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { sanitizeText, sanitizePhone } from '@/lib/sanitize'
import { normalizePhone } from '@/lib/phone'
import { writeAudit } from '@/lib/audit'
import { isAdminRole } from '@/lib/adminNav'
import { RESTAURANT_PHOTO_REQUIRED_TEXT, hasPictureUrl } from '@/lib/pictureRequired'
import { validateModules, toggleModule } from '@/lib/modules'
import { findOrCreateAccount, type OwnerAccount } from '@/lib/ownerAccount'
import { setRestaurantModules } from '@/lib/modulesServer'

export const dynamic = 'force-dynamic'

// GET /api/admin/restaurants
//
// Every restaurant, with its owner, for the admin Restaurants panel.
//
// WHY THIS EXISTS (Phase 1 of the anon-read RLS fix). The panel used to run
// this exact query in the BROWSER through the anon key:
//
//   supabase.from('restaurants')
//     .select('*, owner:customers!restaurants_customer_id_fkey(id, name, phone)')
//
// That embedded join was the only browser read of `customers` anywhere in the
// app — every other one already goes through supabaseAdmin. It is also the
// reason `customers` cannot simply be locked: PostgREST applies RLS to the
// JOINED table independently, so a deny policy makes `owner` come back null
// rather than erroring, and the owner name/phone block would go silently
// blank. Moving the read here first is what makes the lock safe.
//
// NO FILTERING. The panel's four tabs (all / pending / suspended / deleted)
// filter client-side over one list, and the deleted tab needs soft-deleted
// rows, so this returns everything and lets the panel slice it — same data
// the anon query returned, same order.
//
// AUTHORIZATION: sm_session JWT, any admin role. Deliberately WIDER than the
// POST below, which is super_admin|admin only: moderators may READ this panel
// (adminCanFor(role, 'restaurants') is true for them) but may not create
// restaurants. Narrowing GET to match POST would blank the panel for them.
export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req)
  if (!session || !isAdminRole(session.role)) {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }

  const { data, error } = await supabaseAdmin
    .from('restaurants')
    .select('*, owner:customers!restaurants_customer_id_fkey(id, name, phone)')
    .order('created_at', { ascending: false })

  if (error) {
    console.error('[admin/restaurants] list failed:', error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ restaurants: data ?? [] })
}

// POST /api/admin/restaurants
//
// Admin-authored restaurant (the "add a venue we onboarded offline" path,
// not the public signup queue — that's /api/restaurants/submit).
//
// Authorization: sm_session JWT with role super_admin | admin. Moderators
// cannot create restaurants — same bar as approve/reject.
//
// Owner (body.owner_phone, OPTIONAL since N3):
//   - given: like the other sign-up paths — an existing account is reused, a
//     new number gets an account (body.owner_name then required); one
//     restaurant per number. The owner's restaurant_team row is written.
//   - empty: "managed by Tchop & Ndjoka" (managed_by_platform). No owner, no
//     team, nobody messaged. Vitrine: Commandes is refused until it has an
//     order contact (lib/managedRestaurant.ts). body.whatsapp / phone are its
//     public contact buttons.
// body.publish (default true): listed at once ('active'), else 'pending'.
//
// is_open / is_active / status are server-set, never read from the body.
export async function POST(req: NextRequest) {
  const session = getSessionFromRequest(req)
  if (!session || !['super_admin', 'admin'].includes(session.role)) {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Requête invalide / Invalid request' }, { status: 400 })
  }

  const name        = sanitizeText(body.name, 120)
  const description = sanitizeText(body.description, 500)
  const address     = sanitizeText(body.address, 200)
  const phone       = sanitizeText(body.phone, 32)
  const whatsapp    = sanitizeText(body.whatsapp, 32)
  const logo_url    = typeof body.logo_url === 'string' ? body.logo_url.trim() : ''
  const lat         = Number(body.lat)
  const lng         = Number(body.lng)
  const ownerRaw    = sanitizePhone(body.owner_phone)
  const ownerPhone  = ownerRaw ? normalizePhone(ownerRaw) : ''
  const ownerName   = sanitizeText(body.owner_name, 60)
  const publish     = body.publish !== false
  const actor       = { id: session.id, type: session.role }

  // Mirrors the form's own required-field check so the server is the one
  // enforcing it rather than trusting the client to have run it.
  await getRefData()
  const cityPick = chooseCity(body.city, body.city_other)
  const cuisinePick = chooseCuisine(body.cuisine_type, body.cuisine_other)
  if (!name || !cityPick.ok) {
    return NextResponse.json({ error: !name ? 'Nom et ville requis / Name and city required' : (cityPick as { error: string }).error, field: !name ? 'name' : 'city' }, { status: 400 })
  }
  if (!cuisinePick.ok) return NextResponse.json({ error: cuisinePick.error, field: 'cuisine_type' }, { status: 400 })
  const city = cityPick.city
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return NextResponse.json({ error: 'lat et lng requis / lat and lng required' }, { status: 400 })
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return NextResponse.json({ error: 'Coordonnées hors limites / Coordinates out of range' }, { status: 400 })
  }

  // Modules switched on with the creation (M1). Omitted = Vitrine only.
  let modules: string[] | null = null
  if (body.modules !== undefined) {
    const v = validateModules('restaurant', body.modules)
    if (!v.ok) return NextResponse.json({ error: v.error, field: 'modules' }, { status: 400 })
    modules = v.modules
  }

  // ── Owner, or managed ────────────────────────────────────────────────────
  let owner: OwnerAccount | null = null
  if (ownerPhone) {
    if (!/^\+\d{8,15}$/.test(ownerPhone)) {
      return NextResponse.json({ error: 'Téléphone du propriétaire invalide / Invalid owner phone', field: 'owner_phone' }, { status: 400 })
    }
    const acc = await findOrCreateAccount(ownerPhone, ownerName, city, actor, 'restaurant_owner')
    if (!acc.ok) return NextResponse.json({ error: acc.error, field: acc.field }, { status: acc.status })
    owner = acc.account
    if (!acc.created) {
      const { data: existing } = await supabaseAdmin
        .from('restaurants').select('id, name')
        .or(`whatsapp.eq.${owner.phone},customer_id.eq.${owner.id}`)
        .is('deleted_at', null).neq('status', 'deleted')
        .limit(1)
      if (existing && existing.length > 0) {
        return NextResponse.json({
          error: `Ce numéro a déjà un restaurant (${existing[0].name}). / This number already has a restaurant (${existing[0].name}).`,
          field: 'owner_phone', restaurant_id: existing[0].id,
        }, { status: 409 })
      }
    }
  }
  const managed = owner === null
  // V5: a restaurant with an owner needs its photo (the form's upload lands
  // in logo_url). I1: a managed one may have none — the generated cover
  // shows until a real photo is uploaded.
  if (!managed && !hasPictureUrl(logo_url)) {
    return NextResponse.json({ error: RESTAURANT_PHOTO_REQUIRED_TEXT, field: 'logo_url' }, { status: 400 })
  }
  // A managed restaurant has no order contact yet: Vitrine.
  if (managed && modules) modules = toggleModule('restaurant', modules, 'orders', false)

  const { data, error } = await supabaseAdmin
    .from('restaurants')
    .insert({
      name, description, address, city, phone, logo_url: logo_url || null,
      cuisine_type: cuisinePick.cuisine,
      whatsapp:    owner ? (whatsapp || owner.phone) : (whatsapp || null),
      owner_name:  owner?.name ?? null,
      customer_id: owner?.id ?? null,
      managed_by_platform: managed,
      lat, lng,
      is_open:   false,
      is_active: publish,
      status:    publish ? 'active' : 'pending',
    })
    .select()
    .single()

  if (error || !data) {
    console.error('[admin/restaurants] insert failed:', error?.message)
    return NextResponse.json({ error: error?.message ?? 'Erreur serveur / Server error' }, { status: 500 })
  }

  if (owner) {
    // Same owner row as the other sign-up paths (a DB trigger may already
    // have written it; ignoreDuplicates keeps that one).
    const { error: teamErr } = await supabaseAdmin.from('restaurant_team').upsert(
      { restaurant_id: data.id, customer_id: owner.id, role: 'owner', status: 'active' },
      { onConflict: 'restaurant_id,customer_id', ignoreDuplicates: true },
    )
    if (teamErr) console.error('[admin/restaurants] owner team row:', teamErr.message)
  }

  if (modules && modules.length > 0) {
    const set = await setRestaurantModules(data.id, modules, actor, 'created_by_admin')
    if (set.ok) data.modules = set.after
    else console.error('[admin/restaurants] modules:', set.error)
  }

  if (cityPick.proposed) await recordProposal({ kind: 'city', proposed: cityPick.proposed, by: null, targetType: 'restaurant', targetId: data.id, savedAs: city })
  if (cuisinePick.proposed) await recordProposal({ kind: 'cuisine', proposed: cuisinePick.proposed, by: null, targetType: 'restaurant', targetId: data.id, savedAs: cuisinePick.cuisine })

  await writeAudit({
    action:          'restaurant_created_by_admin',
    targetType:      'restaurant',
    targetId:        data.id,
    performedBy:     session.id,
    performedByType: session.role,
    metadata:        { name, city, owner_id: owner?.id ?? null, managed, published: publish },
  })

  // Same shape as the GET list rows, so the panel shows the owner at once.
  return NextResponse.json({ ok: true, restaurant: { ...data, owner: owner ? { id: owner.id, name: owner.name, phone: owner.phone } : null } })
}
