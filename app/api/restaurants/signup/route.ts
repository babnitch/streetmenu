import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { sanitizeText } from '@/lib/sanitize'
import { rateLimit, rateLimitedResponse, clientIP } from '@/lib/rateLimit'
import { writeAudit } from '@/lib/audit'

export const dynamic = 'force-dynamic'

// POST /api/restaurants/signup
//
// Public vendor signup — the server side of app/join/page.tsx. No session is
// required (that's the point: a restaurateur signs up before they have an
// account), so EVERY moderation-relevant column is set by the server and the
// request body is never spread into the insert.
//
// Replaces a direct anon-key INSERT into the restaurants table that ran in
// the browser, where a caller could set is_active/status themselves and
// publish straight past the moderation queue.
//
// Forced server-side, regardless of what the body says:
//   is_active: false   — the moderation queue keys on this
//                        (app/admin/restaurants/page.tsx filters !is_active)
//   status:   'pending'
//   is_open:  false
//   lat/lng            — derived from `city`, not accepted from the client
//
// Silently ignored if sent: status, is_active, approved, deleted_at,
// suspended_*, commission*, payment_mode, payment_enabled,
// pawapay_merchant_id, customer_id, id. They simply have no path into the
// insert object below.

// City → coordinates. Mirrors the CITIES list in app/join/page.tsx and the
// CITY_CENTERS map in app/page.tsx; kept here so the browser can't pin a new
// restaurant to arbitrary coordinates.
const CITY_COORDS: Record<string, { lat: number; lng: number }> = {
  'Yaoundé': { lat: 3.848,   lng: 11.5021 },
  'Abidjan': { lat: 5.36,    lng: -4.0083 },
  'Dakar':   { lat: 14.6937, lng: -17.4441 },
  'Lomé':    { lat: 6.1375,  lng: 1.2123 },
}

// Uploads come back from /api/upload/image as Supabase storage public URLs.
// Anything else (a data: URI, an attacker-controlled host) is dropped rather
// than rejected, so a storage hiccup never blocks a signup.
function safeLogoUrl(input: unknown): string {
  if (typeof input !== 'string' || !input) return ''
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!base) return ''
  return input.startsWith(`${base}/storage/v1/object/public/`) ? input : ''
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Requête invalide / Invalid request' }, { status: 400 })
  }

  const name         = sanitizeText(body.name, 120)
  const owner_name   = sanitizeText(body.owner_name, 120)
  const whatsapp     = sanitizeText(body.whatsapp, 32)
  const city         = sanitizeText(body.city, 60)
  const neighborhood = sanitizeText(body.neighborhood, 120)
  const cuisine_type = sanitizeText(body.cuisine_type, 80)

  if (!name || !owner_name || !whatsapp || !city || !neighborhood || !cuisine_type) {
    return NextResponse.json(
      { error: 'Tous les champs sont requis / All fields are required' },
      { status: 400 },
    )
  }

  const coords = CITY_COORDS[city]
  if (!coords) {
    return NextResponse.json({ error: 'Ville invalide / Invalid city' }, { status: 400 })
  }

  // Public write endpoint — limit per phone AND per IP so neither a single
  // number nor a single host can flood the moderation queue.
  const limited =
    rateLimit({ key: `restaurant-signup:${whatsapp}`, max: 3,  windowMs: 60 * 60_000 }) ??
    rateLimit({ key: `restaurant-signup-ip:${clientIP(req)}`, max: 10, windowMs: 60 * 60_000 })
  if (limited) return rateLimitedResponse(limited)

  const { data, error } = await supabaseAdmin
    .from('restaurants')
    .insert({
      name,
      owner_name,
      whatsapp,
      city,
      neighborhood,
      // The join form has no separate address field; it reuses the
      // neighbourhood, matching the previous client-side insert.
      address:      neighborhood,
      cuisine_type,
      description:  cuisine_type,
      lat:          coords.lat,
      lng:          coords.lng,
      logo_url:     safeLogoUrl(body.logo_url),
      is_open:      false,
      is_active:    false,
      status:       'pending',
    })
    .select('id')
    .single()

  if (error || !data) {
    console.error('[restaurants/signup] insert failed:', error?.message)
    return NextResponse.json({ error: error?.message ?? 'Erreur serveur / Server error' }, { status: 500 })
  }

  await writeAudit({
    action:          'restaurant_signup_submitted',
    targetType:      'restaurant',
    targetId:        data.id,
    performedByType: 'public',
    metadata:        { name, city, neighborhood, cuisine_type },
  })

  return NextResponse.json({ ok: true, id: data.id })
}
