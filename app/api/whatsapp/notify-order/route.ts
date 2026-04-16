import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { notifyVendorNewOrder } from '@/lib/whatsapp'

export async function POST(req: NextRequest) {
  try {
    const { orderId } = await req.json()
    if (!orderId) return NextResponse.json({ error: 'orderId required' }, { status: 400 })

    // Fetch order + restaurant in parallel
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
      .select('name, whatsapp')
      .eq('id', order.restaurant_id)
      .single()

    if (restErr || !restaurant?.whatsapp) {
      // No WhatsApp configured — not an error, just skip silently
      return NextResponse.json({ ok: true, skipped: true })
    }

    await notifyVendorNewOrder(restaurant.whatsapp, order, restaurant.name)

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[notify-order]', err)
    return NextResponse.json({ error: 'internal error' }, { status: 500 })
  }
}
