import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'

export const dynamic = 'force-dynamic'

// GET /api/restaurants/ratings-summary?ids=a,b,c
// Bulk endpoint for the home page. Returns a map { restaurant_id → { average, count } }
// for every id with at least one rating. Restaurants with no ratings are
// absent from the response so the client can render the card cleanly without
// "⭐ 0 (0)".
export async function GET(req: NextRequest) {
  const idsParam = req.nextUrl.searchParams.get('ids') ?? ''
  const ids = idsParam.split(',').map(s => s.trim()).filter(Boolean).slice(0, 200)
  if (ids.length === 0) return NextResponse.json({ summary: {} })

  const { data } = await supabaseAdmin
    .from('restaurant_ratings')
    .select('restaurant_id, rating')
    .in('restaurant_id', ids)

  const acc: Record<string, { total: number; count: number }> = {}
  for (const r of data ?? []) {
    const a = acc[r.restaurant_id] ?? { total: 0, count: 0 }
    a.total += Number(r.rating)
    a.count += 1
    acc[r.restaurant_id] = a
  }
  const summary: Record<string, { average: number; count: number }> = {}
  for (const [id, { total, count }] of Object.entries(acc)) {
    summary[id] = { average: Math.round((total / count) * 10) / 10, count }
  }
  return NextResponse.json({ summary })
}
