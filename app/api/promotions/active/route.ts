import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromRequest } from '@/lib/auth'
import { getActivePromotions, type Placement, type TargetType } from '@/lib/promotions'

export const dynamic = 'force-dynamic'

// GET /api/promotions/active?city=Yaoundé&type=restaurant[&placement=...]
// Returns active promotions for the city + target type. The promoter
// themselves is filtered out so they don't inflate their own
// impressions while scrolling the public feed.
export async function GET(req: NextRequest) {
  const url   = new URL(req.url)
  const city  = String(url.searchParams.get('city') ?? '').trim()
  const type  = String(url.searchParams.get('type') ?? '').trim() as TargetType
  const place = url.searchParams.get('placement') as Placement | null

  if (!city) return NextResponse.json({ promotions: [] })
  if (!['restaurant', 'event'].includes(type)) return NextResponse.json({ promotions: [] })

  const session = getSessionFromRequest(req)
  const promos = await getActivePromotions({
    city,
    targetType: type,
    placement:  place ?? undefined,
    viewerCustomerId: session?.role === 'customer' ? session.id : null,
  })
  return NextResponse.json({ promotions: promos })
}
