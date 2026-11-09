import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromRequest } from '@/lib/auth'
import { saveRestaurantDetails } from '@/lib/restaurantDetailsServer'

export const dynamic = 'force-dynamic'

// POST /api/admin/restaurants/[id]/info — Admin → Restaurants → « Infos du
// restaurant »: name, description, cuisine, city, area, address, map pin,
// phone, WhatsApp of ANY restaurant (managed ones with no owner too). Same
// checks as the owner's route (a city we serve, the pin inside it, one
// restaurant per WhatsApp number); audited old → new. Photos and logo go
// through /api/admin/restaurants/[id]/photo. A deleted restaurant can't be
// changed. super_admin | admin.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionFromRequest(req)
  if (!session || (session.role !== 'super_admin' && session.role !== 'admin')) {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }
  if (!/^[0-9a-f-]{36}$/i.test(params.id)) return NextResponse.json({ error: 'Introuvable / Not found' }, { status: 404 })
  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  const r = await saveRestaurantDetails({ restaurantId: params.id, body, actor: { id: session.id, type: session.role } })
  if (!r.ok) return NextResponse.json({ error: r.error, field: r.field }, { status: r.status })
  return NextResponse.json({ ok: true, restaurant: r.restaurant, changed: r.changed })
}
