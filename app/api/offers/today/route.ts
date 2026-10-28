import { NextRequest, NextResponse } from 'next/server'
import { loadRestaurantOffersToday } from '@/lib/offersServer'

export const dynamic = 'force-dynamic'

// GET /api/offers/today?restaurant_id=…
//
// Today's offers for one restaurant (V2): { today, free_delivery, prices }
// where prices maps menu_item_id → offer price. Public: it shows only what
// the restaurant page shows anyway. menu_offers is server-only (RLS), so
// pages read offers here rather than through the anon client.
export async function GET(req: NextRequest) {
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
