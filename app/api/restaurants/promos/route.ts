import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'

export const dynamic = 'force-dynamic'

// GET /api/restaurants/promos?city=Yaoundé
//
// Restaurant ids that currently have at least one live voucher — backs the
// 💰 Promo filter pill on the mobile home page. A voucher counts when it is
// active, not expired, has quota left, and is scoped to a restaurant (a
// city-wide or platform-wide voucher like BIENVENUE applies everywhere, so
// it isn't a per-restaurant signal and is deliberately excluded).
//
// `city` narrows to vouchers targeting that city plus the city-agnostic
// ones; omit it to get every city.
//
// Public + unauthenticated: it exposes nothing beyond "this restaurant has
// a deal", which the voucher list already shows customers.
export async function GET(req: NextRequest) {
  const city = req.nextUrl.searchParams.get('city')?.trim() || null

  let q = supabaseAdmin
    .from('vouchers')
    .select('restaurant_id, city, expires_at, max_uses, uses_count')
    .eq('is_active', true)
    .not('restaurant_id', 'is', null)

  if (city) q = q.or(`city.is.null,city.eq.${city}`)

  const { data, error } = await q
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const now = Date.now()
  const ids = new Set<string>()
  for (const v of (data ?? []) as Array<{
    restaurant_id: string | null
    expires_at: string | null
    max_uses: number | null
    uses_count: number | null
  }>) {
    if (!v.restaurant_id) continue
    if (v.expires_at && new Date(v.expires_at).getTime() < now) continue
    if (v.max_uses != null && (v.uses_count ?? 0) >= v.max_uses) continue
    ids.add(v.restaurant_id)
  }

  return NextResponse.json({ restaurantIds: Array.from(ids) })
}
