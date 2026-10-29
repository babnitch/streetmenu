import { scanUrl } from '@/lib/scanTokens'
import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { notifyCustomerOrderPlaced, getLangByPhone } from '@/lib/whatsapp'
import { notifyVendorsOfNewOrder, prepTimeLine, deliveryInfoFromOrder } from '@/lib/whatsapp/ordering'
import { ORDERS_URL } from '@/lib/siteLinks'

export const dynamic = 'force-dynamic'

// A guest order (no customer account) can only be announced shortly after it
// was placed. Logged-in orders are tied to the session instead.
const GUEST_WINDOW_MS = 15 * 60 * 1000

// Called by the web order page after a pay-at-pickup order is inserted.
// Sends, once per order:
//   1. "Order received" to orders.customer_phone;
//   2. the "new order" fan-out to restaurants.whatsapp plus active
//      owner/manager rows in restaurant_team (same recipients and format as
//      WhatsApp orders).
//
// Who may call it:
//   - the order's own customer (session), or an admin;
//   - for a guest order, anyone within GUEST_WINDOW_MS of its creation.
// Paid orders are refused: the payment settlement sends their messages.
// orders.notified_at is claimed atomically before sending, so a repeat call
// (double click, replay, someone with the order id) sends nothing.
//
// Both sides are awaited in parallel so the Vercel response lifecycle can't
// cut short the Twilio fetches. Failures are logged, never thrown — the
// order is valid regardless of WhatsApp delivery.
export async function POST(req: NextRequest) {
  try {
    const session = getSessionFromRequest(req)
    const { orderId } = await req.json().catch(() => ({}))
    if (!orderId || typeof orderId !== 'string') return NextResponse.json({ error: 'orderId required' }, { status: 400 })
    console.log(`[notify-order] received orderId=${orderId}`)

    const { data: order, error: orderErr } = await supabaseAdmin
      .from('orders')
      .select('id, customer_id, customer_name, customer_phone, items, total_price, created_at, restaurant_id, order_type, notified_at, fulfilment, delivery_fee, delivery_address, delivery_landmark, delivery_phone')
      .eq('id', orderId)
      .maybeSingle()

    if (orderErr || !order) {
      return NextResponse.json({ error: 'order not found' }, { status: 404 })
    }

    const isAdmin = !!session && ['super_admin', 'admin'].includes(session.role)
    const allowed = isAdmin || (order.customer_id
      ? session?.role === 'customer' && session.id === order.customer_id
      : Date.now() - new Date(order.created_at as string).getTime() < GUEST_WINDOW_MS)
    if (!allowed) {
      return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 403 })
    }

    if (order.order_type === 'paid_order') {
      return NextResponse.json({
        error: 'Commande payée : notifiée au paiement / Paid order: notified on payment',
      }, { status: 409 })
    }

    // Claim the send. Only the call that flips notified_at from NULL sends.
    const { data: claimed, error: claimErr } = await supabaseAdmin
      .from('orders')
      .update({ notified_at: new Date().toISOString() })
      .eq('id', order.id)
      .is('notified_at', null)
      .select('id')
    if (claimErr) {
      console.error('[notify-order] claim failed:', claimErr.message)
      return NextResponse.json({ error: 'internal error' }, { status: 500 })
    }
    if (!claimed || claimed.length === 0) {
      console.log(`[notify-order] already sent orderId=${orderId}`)
      return NextResponse.json({ ok: true, alreadySent: true })
    }

    const { data: restaurant, error: restErr } = await supabaseAdmin
      .from('restaurants')
      .select('id, name')
      .eq('id', order.restaurant_id)
      .single()

    if (restErr || !restaurant) {
      return NextResponse.json({ error: 'restaurant not found' }, { status: 404 })
    }

    const items = (Array.isArray(order.items) ? order.items : []) as Array<{ name: string; quantity: number; price: number }>
    const total = Number(order.total_price)
    // Q1: the order's QR link (the account orders page if it can't be made).
    const trackingUrl = await scanUrl('order', order.id).catch(() => ORDERS_URL)
    // Single-language prep line + customer ping per the recipient's
    // preferred_language. prepTimeLine accepts a lang so the estimate label
    // matches the rest of the message.
    const lang = await getLangByPhone(order.customer_phone)
    const custPrepLine = await prepTimeLine(order.restaurant_id, '🕐', lang, order.fulfilment)

    const customerPromise = order.customer_phone
      ? notifyCustomerOrderPlaced(order.customer_phone, {
          id: order.id,
          customer_name: order.customer_name,
          customer_phone: order.customer_phone,
          items,
          total_price: total,
          created_at: order.created_at,
        }, restaurant.name, trackingUrl, custPrepLine, lang)
      : Promise.resolve()

    const vendorPromise = notifyVendorsOfNewOrder(
      restaurant.id,
      restaurant.name,
      order.id,
      order.customer_name,
      order.customer_phone,
      items,
      total,
      deliveryInfoFromOrder(order),
    )

    const [customerResult, vendorResult] = await Promise.allSettled([customerPromise, vendorPromise])

    if (customerResult.status === 'rejected') {
      console.error('[notify-order] customer notify failed:', String(customerResult.reason))
    }
    if (vendorResult.status === 'rejected') {
      console.error('[notify-order] vendor fan-out failed:', String(vendorResult.reason))
    }

    console.log(`[notify-order] done orderId=${orderId} customerStatus=${customerResult.status} vendorStatus=${vendorResult.status}`)

    return NextResponse.json({
      ok: true,
      customerNotified: customerResult.status === 'fulfilled' && !!order.customer_phone,
      vendorFanoutStatus: vendorResult.status,
    })
  } catch (err) {
    console.error('[notify-order] internal error:', err)
    return NextResponse.json({ error: 'internal error' }, { status: 500 })
  }
}
