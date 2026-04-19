import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { notifyCustomerOrderPlaced } from '@/lib/whatsapp'
import { notifyVendorsOfNewOrder } from '@/lib/whatsapp/ordering'

export const dynamic = 'force-dynamic'

// Called by the web order page after a successful orders insert. Sends:
//   1. A customer confirmation to orders.customer_phone (whether logged-in or
//      guest — we trust whatever phone is on the row).
//   2. A vendor fan-out to restaurants.whatsapp plus active owner/manager
//      rows in restaurant_team — same recipient logic and message format as
//      WhatsApp-initiated orders.
//
// Both sides are awaited in parallel so the Vercel response lifecycle can't
// cut short the Twilio fetches. Failures are logged, never thrown — the
// order is valid regardless of WhatsApp delivery.
export async function POST(req: NextRequest) {
  try {
    const { orderId } = await req.json()
    if (!orderId) return NextResponse.json({ error: 'orderId required' }, { status: 400 })

    const { data: order, error: orderErr } = await supabaseAdmin
      .from('orders')
      .select('id, customer_name, customer_phone, items, total_price, created_at, restaurant_id')
      .eq('id', orderId)
      .single()

    if (orderErr || !order) {
      return NextResponse.json({ error: 'order not found' }, { status: 404 })
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
    const trackingUrl = 'https://streetmenu.vercel.app/account'

    const customerPromise = order.customer_phone
      ? notifyCustomerOrderPlaced(order.customer_phone, {
          id: order.id,
          customer_name: order.customer_name,
          customer_phone: order.customer_phone,
          items,
          total_price: total,
          created_at: order.created_at,
        }, restaurant.name, trackingUrl)
      : Promise.resolve()

    const vendorPromise = notifyVendorsOfNewOrder(
      restaurant.id,
      restaurant.name,
      order.id,
      order.customer_name,
      order.customer_phone,
      items,
      total,
    )

    const [customerResult, vendorResult] = await Promise.allSettled([customerPromise, vendorPromise])

    if (customerResult.status === 'rejected') {
      console.error('[notify-order] customer notify failed:', String(customerResult.reason))
    }
    if (vendorResult.status === 'rejected') {
      console.error('[notify-order] vendor fan-out failed:', String(vendorResult.reason))
    }

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
