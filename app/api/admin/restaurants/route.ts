import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { sanitizeText } from '@/lib/sanitize'
import { writeAudit } from '@/lib/audit'

export const dynamic = 'force-dynamic'

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
