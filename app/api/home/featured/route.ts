import { NextRequest, NextResponse } from 'next/server'
import { getRefData } from '@/lib/refDataServer'
import { isServedCity } from '@/lib/cities'
import { homeFeaturedCard } from '@/lib/homeFeaturedServer'

export const dynamic = 'force-dynamic'

// GET /api/home/featured?city=Yaoundé — the home page's "À la une" card
// (lib/homeFeatured.ts), or { item: null } when the city has none.
export async function GET(req: NextRequest) {
  await getRefData()
  const city = req.nextUrl.searchParams.get('city') ?? ''
  if (!isServedCity(city)) return NextResponse.json({ error: 'city' }, { status: 400 })
  const item = await homeFeaturedCard(city)
  return NextResponse.json({ item }, { headers: { 'Cache-Control': 'no-store' } })
}
