import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromRequest } from '@/lib/auth'
import { getPromotionEligibility, getActivePricing } from '@/lib/promotions'

export const dynamic = 'force-dynamic'

// GET /api/promotions/eligibility
// Returns what the caller can promote (their restaurants + events) plus
// the active pricing table so the compose form can render in one shot.
export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req)
  if (!session || session.role !== 'customer') {
    return NextResponse.json({
      eligible: false,
      restaurants: [],
      events: [],
      pricing: null,
    })
  }
  const [elig, pricing] = await Promise.all([
    getPromotionEligibility(session.id),
    getActivePricing(),
  ])
  return NextResponse.json({
    eligible: elig.restaurants.length > 0 || elig.events.length > 0,
    restaurants: elig.restaurants,
    events: elig.events,
    pricing,
  })
}
