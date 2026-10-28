import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { denyUnlessOwnerOrManager } from '@/lib/vendorAccess'
import { requireRestaurantModule } from '@/lib/modulesServer'
import { writeAudit } from '@/lib/audit'
import { dateInZone, restaurantZone, validateOffer } from '@/lib/offers'

export const dynamic = 'force-dynamic'

// Offer of the day (V2), for the dashboard. Owner, manager or admin.
//
// GET  → { today, offers } — offers that haven't ended yet (today or later,
//        in the restaurant's own day), with the dish name and menu price.
// POST { kind: 'price', menu_item_id, offer_price, starts_on?, ends_on? }
//   or { kind: 'free_delivery', starts_on?, ends_on? }
//        Dates default to today. Refused: a past start, a price not below
//        the menu price, free delivery while delivery is off, or an offer
//        overlapping another one for the same dish (or another free-delivery
//        offer) — one clear price per dish and day.

async function restaurantOf(id: string) {
  const { data } = await supabaseAdmin
    .from('restaurants').select('id, timezone, city, delivery_enabled').eq('id', id).maybeSingle()
  return data
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = await denyUnlessOwnerOrManager(req, params.id)
  if (denied) return denied
  const rest = await restaurantOf(params.id)
  if (!rest) return NextResponse.json({ error: 'Restaurant introuvable / not found' }, { status: 404 })
  const today = dateInZone(restaurantZone(rest))

  const { data, error } = await supabaseAdmin
    .from('menu_offers')
    .select('id, kind, menu_item_id, offer_price, starts_on, ends_on, menu_item:menu_items!menu_offers_menu_item_id_fkey(name, price)')
    .eq('restaurant_id', params.id)
    .gte('ends_on', today)
    .order('starts_on', { ascending: true })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ today, offers: data ?? [] }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = await denyUnlessOwnerOrManager(req, params.id)
  if (denied) return denied
  // M3: publishing offers needs the Offre du jour module.
  const offerOff = await requireRestaurantModule(params.id, 'daily_offer')
  if (offerOff) return offerOff
  const session = getSessionFromRequest(req)!
  const rest = await restaurantOf(params.id)
  if (!rest) return NextResponse.json({ error: 'Restaurant introuvable / not found' }, { status: 404 })
  const today = dateInZone(restaurantZone(rest))

  const body = await req.json().catch(() => ({}))

  let regular: number | null = null
  if (body?.kind === 'price') {
    const itemId = typeof body?.menu_item_id === 'string' ? body.menu_item_id : ''
    const { data: item } = itemId
      ? await supabaseAdmin.from('menu_items').select('id, price').eq('id', itemId).eq('restaurant_id', params.id).maybeSingle()
      : { data: null }
    if (!item) return NextResponse.json({ error: 'Plat introuvable / Dish not found' }, { status: 404 })
    regular = Math.round(Number(item.price))
  }

  const v = validateOffer(body ?? {}, today, regular)
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 })
  const offer = v.offer

  if (offer.kind === 'free_delivery' && rest.delivery_enabled !== true) {
    return NextResponse.json({
      error: 'Activez d\'abord la livraison (Paramètres) / Turn delivery on first (Settings)',
    }, { status: 409 })
  }

  // Overlap: same dish (or free delivery) on any shared day.
  let overlap = supabaseAdmin
    .from('menu_offers').select('id')
    .eq('restaurant_id', params.id).eq('kind', offer.kind)
    .lte('starts_on', offer.ends_on).gte('ends_on', offer.starts_on)
  overlap = offer.menu_item_id ? overlap.eq('menu_item_id', offer.menu_item_id) : overlap
  const { data: clash } = await overlap.limit(1)
  if (clash && clash.length > 0) {
    return NextResponse.json({
      error: 'Une offre existe déjà ces jours-là. Supprimez-la d\'abord. / An offer already exists on those days. Delete it first.',
    }, { status: 409 })
  }

  const { data: created, error } = await supabaseAdmin
    .from('menu_offers')
    .insert({ restaurant_id: params.id, ...offer, created_by: session.id })
    .select('id, kind, menu_item_id, offer_price, starts_on, ends_on')
    .single()
  if (error || !created) {
    console.error('[offers] insert failed:', error?.message)
    return NextResponse.json({ error: 'Erreur serveur / Server error' }, { status: 500 })
  }

  await writeAudit({
    action: 'menu_offer_created', targetType: 'restaurant', targetId: params.id,
    performedBy: session.id, performedByType: session.role === 'customer' ? 'vendor' : session.role,
    metadata: { offer_id: created.id, ...offer },
  })
  return NextResponse.json({ ok: true, offer: created })
}
