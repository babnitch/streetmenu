import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { sanitizeText } from '@/lib/sanitize'
import { writeAudit } from '@/lib/audit'
import { isAdminRole } from '@/lib/adminNav'

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
// Admin-authored restaurant, created already-live (this is the "add a venue
// we onboarded offline" path, not the public signup queue — that's
// /api/restaurants/signup, which forces status='pending').
//
// Replaces a browser-side anon-key INSERT into the restaurants table whose
// only gate was a localStorage flag.
//
// Authorization: sm_session JWT with role super_admin | admin. Moderators
// cannot create restaurants — same bar as approve/reject.
//
// is_open / is_active / status are server constants, not read from the body.
// An admin is allowed a live row; it just isn't client-controlled, so a
// crafted request can't reach any other column either.
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
  const city        = sanitizeText(body.city, 60)
  const phone       = sanitizeText(body.phone, 32)
  const whatsapp    = sanitizeText(body.whatsapp, 32)
  const logo_url    = typeof body.logo_url === 'string' ? body.logo_url : ''
  const lat         = Number(body.lat)
  const lng         = Number(body.lng)

  // Mirrors the form's own required-field check so the server is the one
  // enforcing it rather than trusting the client to have run it.
  if (!name || !city) {
    return NextResponse.json({ error: 'Nom et ville requis / Name and city required' }, { status: 400 })
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return NextResponse.json({ error: 'lat et lng requis / lat and lng required' }, { status: 400 })
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return NextResponse.json({ error: 'Coordonnées hors limites / Coordinates out of range' }, { status: 400 })
  }

  const { data, error } = await supabaseAdmin
    .from('restaurants')
    .insert({
      name, description, address, city, phone, whatsapp, logo_url,
      lat, lng,
      is_open:   false,
      is_active: true,
      status:    'active',
    })
    .select()
    .single()

  if (error || !data) {
    console.error('[admin/restaurants] insert failed:', error?.message)
    return NextResponse.json({ error: error?.message ?? 'Erreur serveur / Server error' }, { status: 500 })
  }

  await writeAudit({
    action:          'restaurant_created_by_admin',
    targetType:      'restaurant',
    targetId:        data.id,
    performedBy:     session.id,
    performedByType: session.role,
    metadata:        { name, city },
  })

  return NextResponse.json({ ok: true, restaurant: data })
}
