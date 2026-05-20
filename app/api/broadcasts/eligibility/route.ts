import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromRequest } from '@/lib/auth'
import { getBroadcastEligibility, getActivePricing, hasRecentBroadcast } from '@/lib/subscriptions'

export const dynamic = 'force-dynamic'

// GET /api/broadcasts/eligibility
// Returns whether the caller can broadcast, what senders they can use
// (publisher or any of their owned restaurants), the active pricing row,
// and whether they've already broadcast in the last 24h.
export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req)
  if (!session || session.role !== 'customer') {
    return NextResponse.json({
      eligible: false,
      blocked: false,
      asPublisher: false,
      asRestaurants: [],
      pricing: null,
      rate_limited: false,
    })
  }

  const [eligibility, pricing, recent] = await Promise.all([
    getBroadcastEligibility(session.id),
    getActivePricing(),
    hasRecentBroadcast(session.id),
  ])

  return NextResponse.json({
    eligible: eligibility.asPublisher || eligibility.asRestaurants.length > 0,
    blocked: eligibility.blocked,
    asPublisher: eligibility.asPublisher,
    asRestaurants: eligibility.asRestaurants,
    pricing,
    rate_limited: recent,
  })
}
