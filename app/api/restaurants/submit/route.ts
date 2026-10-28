import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { sanitizeText } from '@/lib/sanitize'
import { rateLimit, rateLimitedResponse, clientIP } from '@/lib/rateLimit'
import { writeAudit } from '@/lib/audit'
import { sendWhatsApp, getLangByPhone } from '@/lib/whatsapp'
import { cityCentre, isFoodType, acceptPosition, registeredText } from '@/lib/restaurantSignup'
import { RESTAURANT_PHOTO_REQUIRED_TEXT } from '@/lib/pictureRequired'

export const dynamic = 'force-dynamic'

const BASE_URL = 'https://streetmenu.vercel.app'

// Uploads come back from /api/upload/image as Supabase storage public URLs;
// anything else counts as no photo.
function safeImageUrl(input: unknown): string | null {
  if (typeof input !== 'string' || !input) return null
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL
  return base && input.startsWith(`${base}/storage/v1/object/public/`) ? input : null
}

// POST /api/restaurants/submit — "Ajouter un restaurant" on the web, for a
// logged-in customer. Does exactly what the WhatsApp signup does:
//   - owner = the account, WhatsApp number = the account's phone (verified at
//     login), inactive and pending until an admin approves;
//   - photo in image_url (required, V5), city / neighbourhood / food type from the shared
//     lists (lib/restaurantSignup.ts);
//   - map pin: the phone's position when sent and near the city, else the
//     city centre (never 0,0);
//   - an owner row in restaurant_team (also made by a database trigger where
//     it exists — this is the safety net);
//   - the bot's "registered, pending approval" WhatsApp, an audit row.
// One restaurant per number, as on WhatsApp (the bot recognises a vendor by
// that number). A half-finished WhatsApp signup for the number is cleared.
//
// Body: { name, city, neighborhood, cuisine_type, image_url, lat?, lng? }
export async function POST(req: NextRequest) {
  const session = getSessionFromRequest(req)
  if (!session || session.role !== 'customer') {
    return NextResponse.json({ error: 'Connexion requise / Login required', login_required: true }, { status: 401 })
  }
  const limited = rateLimit({ key: `restaurant-submit:${session.id}`, max: 5, windowMs: 3600_000 })
    ?? rateLimit({ key: `restaurant-submit-ip:${clientIP(req)}`, max: 20, windowMs: 3600_000 })
  if (limited) return rateLimitedResponse(limited)

  const body = await req.json().catch(() => ({}))
  const name         = sanitizeText(body?.name, 120)
  const city         = sanitizeText(body?.city, 40)
  const neighborhood = sanitizeText(body?.neighborhood, 80)
  const cuisine      = body?.cuisine_type
  if (name.length < 2 || neighborhood.length < 2) {
    return NextResponse.json({ error: 'Nom et quartier requis / Name and neighbourhood required' }, { status: 400 })
  }
  const centre = cityCentre(city)
  if (!centre) return NextResponse.json({ error: 'Ville invalide / Invalid city' }, { status: 400 })
  if (!isFoodType(cuisine)) return NextResponse.json({ error: 'Type de cuisine invalide / Invalid food type' }, { status: 400 })
  const imageUrl = safeImageUrl(body?.image_url)
  if (!imageUrl) return NextResponse.json({ error: RESTAURANT_PHOTO_REQUIRED_TEXT, field: 'image_url' }, { status: 400 })

  const { data: me } = await supabaseAdmin
    .from('customers').select('id, phone, name, status').eq('id', session.id).maybeSingle()
  if (!me || me.status === 'suspended') {
    return NextResponse.json({ error: 'Compte indisponible / Account unavailable' }, { status: 403 })
  }

  const { data: existing } = await supabaseAdmin
    .from('restaurants').select('id, name')
    .or(`whatsapp.eq.${me.phone},customer_id.eq.${me.id}`)
    .is('deleted_at', null).neq('status', 'deleted')
    .limit(1)
  if (existing && existing.length > 0) {
    return NextResponse.json({
      error: `Ce numéro a déjà un restaurant (${existing[0].name}). / This number already has a restaurant (${existing[0].name}).`,
      restaurant_id: existing[0].id,
    }, { status: 409 })
  }

  const pos = acceptPosition(city, body?.lat, body?.lng) ?? centre
  const { data: created, error } = await supabaseAdmin
    .from('restaurants')
    .insert({
      name,
      city,
      neighborhood,
      cuisine_type: cuisine,
      image_url:    imageUrl,
      whatsapp:     me.phone,
      owner_name:   me.name,
      customer_id:  me.id,
      is_active:    false,
      status:       'pending',
      is_open:      false,
      lat:          pos.lat,
      lng:          pos.lng,
    })
    .select('id, name')
    .single()
  if (error || !created) {
    console.error('[restaurants/submit] insert failed:', error?.message)
    return NextResponse.json({ error: 'Erreur — réessayez. / Error — please try again.' }, { status: 500 })
  }

  await supabaseAdmin.from('signup_sessions').delete().eq('phone', me.phone)
  const { error: teamErr } = await supabaseAdmin.from('restaurant_team').upsert(
    { restaurant_id: created.id, customer_id: me.id, role: 'owner', status: 'active' },
    { onConflict: 'restaurant_id,customer_id', ignoreDuplicates: true },
  )
  if (teamErr) console.error('[restaurants/submit] owner team row:', teamErr.message)

  await writeAudit({
    action: 'restaurant_submitted', targetType: 'restaurant', targetId: created.id,
    performedBy: me.id, performedByType: 'customer',
    metadata: { name, city, cuisine_type: cuisine, via: 'web', pin: pos === centre ? 'city_centre' : 'device' },
  })

  const lang = await getLangByPhone(me.phone)
  await sendWhatsApp(me.phone, registeredText(name, `${BASE_URL}/restaurant/${created.id}`, lang), {
    context: 'account_notice', customerId: me.id,
  }).catch(() => null)

  return NextResponse.json({ ok: true, restaurant: created })
}
