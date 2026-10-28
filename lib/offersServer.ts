// Server-only: the offers live today, per restaurant (V2).
//
// One place reads menu_offers for pricing (lib/orderPricing.ts), the bot's
// menu, and the public /api/offers/today. "Today" is each restaurant's own
// calendar day (lib/offers.ts), so offers start and end at local midnight.

import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { dateInZone, restaurantZone, isOfferLive, addDaysISO, type MenuOffer } from '@/lib/offers'

export interface TodayOffers {
  today: string
  // menu_item_id → offer price. When two offers overlap, the lower price wins.
  prices: Record<string, number>
  freeDelivery: boolean
  offers: MenuOffer[]
}

const EMPTY = (today: string): TodayOffers => ({ today, prices: {}, freeDelivery: false, offers: [] })

export async function loadTodayOffers(restaurantIds: string[], at: Date = new Date()): Promise<Record<string, TodayOffers>> {
  const out: Record<string, TodayOffers> = {}
  const ids = Array.from(new Set(restaurantIds.filter(Boolean)))
  if (ids.length === 0) return out

  const { data: rests } = await supabaseAdmin
    .from('restaurants').select('id, timezone, city').in('id', ids)
  const todayById = new Map<string, string>()
  for (const r of rests ?? []) {
    const today = dateInZone(restaurantZone(r), at)
    todayById.set(r.id as string, today)
    out[r.id as string] = EMPTY(today)
  }
  if (todayById.size === 0) return out

  // Every zone we serve is within a day of UTC, so a ±1 day window around
  // the UTC date catches every restaurant's "today"; the exact check is below.
  const utc = at.toISOString().slice(0, 10)
  const { data, error } = await supabaseAdmin
    .from('menu_offers')
    .select('id, restaurant_id, menu_item_id, kind, offer_price, starts_on, ends_on')
    .in('restaurant_id', Array.from(todayById.keys()))
    .lte('starts_on', addDaysISO(utc, 1))
    .gte('ends_on', addDaysISO(utc, -1))
  if (error) {
    console.error('[offers] load failed:', error.message)
    return out
  }

  for (const o of (data ?? []) as MenuOffer[]) {
    const t = out[o.restaurant_id]
    if (!t || !isOfferLive(o, t.today)) continue
    t.offers.push(o)
    if (o.kind === 'free_delivery') t.freeDelivery = true
    else if (o.menu_item_id && o.offer_price != null) {
      const prev = t.prices[o.menu_item_id]
      t.prices[o.menu_item_id] = prev == null ? o.offer_price : Math.min(prev, o.offer_price)
    }
  }
  return out
}

export async function loadRestaurantOffersToday(restaurantId: string, at?: Date): Promise<TodayOffers> {
  const all = await loadTodayOffers([restaurantId], at)
  return all[restaurantId] ?? EMPTY(dateInZone('Africa/Douala', at))
}
