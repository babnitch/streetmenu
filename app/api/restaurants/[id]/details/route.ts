import { NextRequest, NextResponse } from 'next/server'
import { getSessionFromRequest } from '@/lib/auth'
import { isRestaurantOwner } from '@/lib/vendorAccess'
import { saveRestaurantDetails } from '@/lib/restaurantDetailsServer'

export const dynamic = 'force-dynamic'

// POST /api/restaurants/[id]/details — the OWNER edits the restaurant's own
// details (lib/restaurantDetails.ts, saved by lib/restaurantDetailsServer.ts).
// Live at once, no new approval. Audited (restaurant_details_changed, old →
// new). A change customers rely on (name, address, pin, city, area, phones)
// is also listed for the admins (restaurant_change_notices → Admin →
// Restaurants). Owner only (implicit or team owner); a deleted restaurant
// can't be changed. Admins use /api/admin/restaurants/[id]/info.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionFromRequest(req)
  if (!session || session.role !== 'customer') {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }
  if (!/^[0-9a-f-]{36}$/i.test(params.id)) return NextResponse.json({ error: 'Introuvable / Not found' }, { status: 404 })
  if (!(await isRestaurantOwner(params.id, session.id))) {
    return NextResponse.json({ error: 'Réservé au propriétaire / Owner only' }, { status: 403 })
  }
  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  const r = await saveRestaurantDetails({ restaurantId: params.id, body, actor: { id: session.id, type: 'owner' } })
  if (!r.ok) return NextResponse.json({ error: r.error, field: r.field }, { status: r.status })
  return NextResponse.json({ ok: true, restaurant: r.restaurant, changed: r.changed })
}
