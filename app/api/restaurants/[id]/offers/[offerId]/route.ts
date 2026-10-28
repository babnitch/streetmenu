import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { denyUnlessOwnerOrManager } from '@/lib/vendorAccess'
import { writeAudit } from '@/lib/audit'

export const dynamic = 'force-dynamic'

// DELETE /api/restaurants/[id]/offers/[offerId] — ends an offer now (V2).
// Owner, manager or admin of that restaurant.
export async function DELETE(req: NextRequest, { params }: { params: { id: string; offerId: string } }) {
  const denied = await denyUnlessOwnerOrManager(req, params.id)
  if (denied) return denied
  const session = getSessionFromRequest(req)!

  const { data: gone, error } = await supabaseAdmin
    .from('menu_offers').delete()
    .eq('id', params.offerId).eq('restaurant_id', params.id)
    .select('id, kind, menu_item_id, offer_price, starts_on, ends_on')
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!gone || gone.length === 0) return NextResponse.json({ error: 'Offre introuvable / Offer not found' }, { status: 404 })

  await writeAudit({
    action: 'menu_offer_deleted', targetType: 'restaurant', targetId: params.id,
    performedBy: session.id, performedByType: session.role === 'customer' ? 'vendor' : session.role,
    previousData: gone[0],
  })
  return NextResponse.json({ ok: true })
}
