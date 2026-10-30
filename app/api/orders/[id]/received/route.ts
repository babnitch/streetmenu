import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { markOrderDelivered } from '@/lib/orderDelivery'
import { releaseOrderFunds } from '@/lib/protectedPayments'

export const dynamic = 'force-dynamic'

// POST /api/orders/[id]/received (Q2) — "J'ai reçu ma commande": the
// customer confirms their own delivery order arrived (it must be out for
// delivery). Recorded as delivered_confirmed_by = customer; the restaurant
// gets one WhatsApp.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionFromRequest(req)
  if (!session || session.role !== 'customer') return NextResponse.json({ error: 'Connexion requise / Login required' }, { status: 401 })
  const { data: o } = await supabaseAdmin.from('orders').select('id, customer_id, status, fulfilment, funds_status').eq('id', params.id).maybeSingle()
  if (!o || o.customer_id !== session.id) return NextResponse.json({ error: 'Commande introuvable / Order not found' }, { status: 404 })
  // Protected payment: "Reçu" confirms a held order (pickup too, or one
  // already marked delivered) and releases the money to the restaurant.
  if (o.funds_status === 'held' && !['pending', 'cancelled'].includes(o.status as string)) {
    if (o.status === 'delivered' || o.status === 'completed') {
      const r = await releaseOrderFunds(o.id as string, 'customer', { id: session.id, type: 'customer' })
      if (!r.ok) return NextResponse.json({ error: r.error }, { status: 409 })
      return NextResponse.json({ ok: true, status: o.status, released: true })
    }
    const m = await markOrderDelivered(o.id as string, 'customer', { id: session.id, type: 'customer' }, { notify: 'restaurant' })
    if (!m.ok) return NextResponse.json({ error: m.error }, { status: m.reason === 'not_found' ? 404 : 409 })
    return NextResponse.json({ ok: true, status: 'delivered', released: true })
  }
  if (o.fulfilment !== 'delivery' || o.status !== 'out_for_delivery') {
    return NextResponse.json({ error: 'Cette commande n\'est pas en livraison / This order is not out for delivery' }, { status: 409 })
  }
  const r = await markOrderDelivered(o.id, 'customer', { id: session.id, type: 'customer' }, { notify: 'restaurant' })
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.reason === 'not_found' ? 404 : 409 })
  return NextResponse.json({ ok: true, status: 'delivered' })
}
