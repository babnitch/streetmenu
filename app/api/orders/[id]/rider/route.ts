import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { denyUnlessOwnerOrManager } from '@/lib/vendorAccess'
import { writeAudit } from '@/lib/audit'
import { OPEN_FOR_RIDER, riderAssignmentMessage, type RiderOrder } from '@/lib/riders'
import { sendWhatsApp, getLangByPhone } from '@/lib/whatsapp'

export const dynamic = 'force-dynamic'

// POST /api/orders/[id]/rider { rider_id | null } (Q5) — assign an open
// delivery order to one of the restaurant's riders (or unassign). The rider
// gets one WhatsApp: order number, items, address, landmark, customer phone,
// cash to collect. Owner / manager / admin.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionFromRequest(req)
  if (!session) return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  const { data: o } = await supabaseAdmin.from('orders')
    .select('id, restaurant_id, status, fulfilment, rider_id, customer_name, customer_phone, items, total_price, delivery_fee, delivery_address, delivery_landmark, delivery_phone, order_type, payment_status')
    .eq('id', params.id).maybeSingle()
  if (!o) return NextResponse.json({ error: 'Commande introuvable / Order not found' }, { status: 404 })
  const denied = await denyUnlessOwnerOrManager(req, o.restaurant_id as string)
  if (denied) return denied
  if (o.fulfilment !== 'delivery' || !(OPEN_FOR_RIDER as readonly string[]).includes(o.status as string)) {
    return NextResponse.json({ error: 'Seulement une livraison en cours / Only an open delivery order' }, { status: 409 })
  }
  const body = await req.json().catch(() => ({})) as { rider_id?: unknown }
  const riderId = typeof body.rider_id === 'string' && body.rider_id ? body.rider_id : null
  let rider: { id: string; phone: string } | null = null
  if (riderId) {
    const { data: r } = await supabaseAdmin.from('restaurant_riders')
      .select('id, customers!restaurant_riders_customer_id_fkey(phone)')
      .eq('id', riderId).eq('restaurant_id', o.restaurant_id).eq('status', 'active').maybeSingle()
    if (!r) return NextResponse.json({ error: 'Livreur introuvable / Rider not found' }, { status: 404 })
    rider = { id: r.id as string, phone: (r.customers as unknown as { phone: string } | null)?.phone ?? '' }
  }
  if ((o.rider_id ?? null) === riderId) return NextResponse.json({ ok: true, rider_id: riderId })
  await supabaseAdmin.from('orders').update({ rider_id: riderId, updated_at: new Date().toISOString() }).eq('id', o.id)
  await writeAudit({
    action: riderId ? 'order_rider_assigned' : 'order_rider_unassigned', targetType: 'order', targetId: o.id as string,
    performedBy: session.id, performedByType: session.role === 'customer' ? 'vendor' : session.role,
    previousData: { rider_id: o.rider_id }, metadata: { rider_id: riderId },
  })
  if (rider?.phone) {
    const { data: rest } = await supabaseAdmin.from('restaurants').select('name').eq('id', o.restaurant_id).maybeSingle()
    const lang = await getLangByPhone(rider.phone)
    await sendWhatsApp(rider.phone, riderAssignmentMessage(o as unknown as RiderOrder, (rest?.name as string | undefined) ?? '', lang),
      { context: 'order_status_update', relatedId: o.id as string })
  }
  return NextResponse.json({ ok: true, rider_id: riderId })
}
