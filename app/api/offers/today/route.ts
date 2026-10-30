import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { loadRestaurantOffersToday, loadTodayOffers } from '@/lib/offersServer'
import { isServedCity } from '@/lib/cities'
import { isSideOn } from '@/lib/platformSwitch'
import { deliversNow } from '@/lib/modules'
import { isDailyMenu, isServedOn, restaurantWeekday } from '@/lib/menuDays'

export const dynamic = 'force-dynamic'

const CITY_LIMIT = 12

// GET /api/offers/today?restaurant_id=…
//   Today's offers for one restaurant (V2): { today, free_delivery, prices }
//   where prices maps menu_item_id → offer price.
// GET /api/offers/today?city=Yaoundé
//   The home page's "Offres du jour" (V3): { offers: [...] }, one entry per
//   dish on offer (dish photo, menu price, offer price) or per restaurant
//   with free delivery, live restaurants of the city only. Empty → hidden.
// Public: it shows only what the restaurant pages show anyway. menu_offers is
// server-only (RLS), so pages read offers here, not through the anon client.
export async function GET(req: NextRequest) {
  // M6: restaurants switched off → no offers anywhere.
  if (!(await isSideOn('restaurants'))) {
    return NextResponse.json({ offers: [], prices: {}, free_delivery: false }, { headers: { 'Cache-Control': 'no-store' } })
  }
  const city = req.nextUrl.searchParams.get('city')
  if (city != null) return cityOffers(city)

  const restaurantId = req.nextUrl.searchParams.get('restaurant_id')?.trim() ?? ''
  if (!/^[0-9a-f-]{36}$/i.test(restaurantId)) {
    return NextResponse.json({ error: 'restaurant_id requis / required' }, { status: 400 })
  }
  const t = await loadRestaurantOffersToday(restaurantId)
  return NextResponse.json(
    { today: t.today, free_delivery: t.freeDelivery, prices: t.prices },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}

interface CityOffer {
  kind: 'price' | 'free_delivery'
  restaurant: { id: string; name: string; image: string | null }
  dish?: { id: string; name: string; photo_url: string | null; regular_price: number; offer_price: number }
  ends_on: string
}

async function cityOffers(city: string) {
  if (!isServedCity(city)) {
    return NextResponse.json({ error: 'city' }, { status: 400 })
  }
  const { data: rests } = await supabaseAdmin.from('restaurants')
    .select('id, name, image_url, logo_url, delivery_enabled, modules, menu_type, timezone, city')
    .eq('city', city).eq('is_active', true).in('status', ['active', 'approved']).is('deleted_at', null)
  const byId = new Map((rests ?? []).map(r => [r.id as string, r]))
  const today = await loadTodayOffers(Array.from(byId.keys()))

  const dishIds = Object.values(today).flatMap(t => Object.keys(t.prices))
  const { data: dishes } = dishIds.length
    ? await supabaseAdmin.from('menu_items').select('id, name, photo_url, price, is_available, available_days').in('id', dishIds)
    : { data: [] as Array<{ id: string; name: string; photo_url: string | null; price: number; is_available: boolean }> }
  const dishById = new Map((dishes ?? []).map(d => [d.id as string, d]))

  const offers: CityOffer[] = []
  for (const [rid, t] of Object.entries(today)) {
    const r = byId.get(rid)
    if (!r) continue
    const restaurant = { id: rid, name: r.name as string, image: (r.image_url || r.logo_url || null) as string | null }
    for (const o of t.offers) {
      if (o.kind === 'free_delivery') {
        if (deliversNow(r)) offers.push({ kind: 'free_delivery', restaurant, ends_on: o.ends_on })
        continue
      }
      const d = o.menu_item_id ? dishById.get(o.menu_item_id) : null
      if (!d || d.is_available === false || o.offer_price == null) continue
      // Menu par jour: only dishes served today.
      if (isDailyMenu(r) && !isServedOn(d as { available_days?: number[] | null }, restaurantWeekday(r), 'daily')) continue
      const regular = Math.round(Number(d.price))
      if (!(o.offer_price < regular)) continue
      offers.push({
        kind: 'price', restaurant, ends_on: o.ends_on,
        dish: { id: d.id as string, name: d.name as string, photo_url: (d.photo_url as string | null) ?? null, regular_price: regular, offer_price: o.offer_price },
      })
    }
  }
  // Biggest saving first; free delivery after the dishes.
  const saving = (o: CityOffer) => o.dish ? 1 - o.dish.offer_price / o.dish.regular_price : 0
  offers.sort((a, b) => saving(b) - saving(a))
  return NextResponse.json({ offers: offers.slice(0, CITY_LIMIT) }, { headers: { 'Cache-Control': 'no-store' } })
}
