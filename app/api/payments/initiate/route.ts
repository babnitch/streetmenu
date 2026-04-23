import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { writeAudit } from '@/lib/audit'
import { createDeposit, detectMNO, mnoLabel, countryFromCity } from '@/lib/pawapay'

export const dynamic = 'force-dynamic'

// POST /api/payments/initiate
// Body: { orderId: string, phoneNumber: string }
//
// Looks up the order + restaurant, asserts payment is enabled, calls PawaPay
// to create a deposit, marks the order pending, and returns the depositId
// for the client to poll. Caller is the web checkout flow OR the WhatsApp
// ordering flow — both go through this same route.
export async function POST(req: NextRequest) {
  try {
    const { orderId, phoneNumber } = await req.json() as { orderId?: string; phoneNumber?: string }
    if (!orderId || !phoneNumber) {
      return NextResponse.json({ error: 'orderId et phoneNumber requis / required' }, { status: 400 })
    }

    const { data: order, error: orderErr } = await supabaseAdmin
      .from('orders')
      .select('id, restaurant_id, total_price, payment_status, customer_phone')
      .eq('id', orderId)
      .single()
    if (orderErr || !order) {
      return NextResponse.json({ error: 'Commande introuvable / Order not found' }, { status: 404 })
    }
    if (order.payment_status === 'paid') {
      return NextResponse.json({ error: 'Commande déjà payée / Already paid' }, { status: 400 })
    }

    const { data: restaurant, error: restErr } = await supabaseAdmin
      .from('restaurants')
      .select('id, name, city, payment_enabled')
      .eq('id', order.restaurant_id)
      .single()
    if (restErr || !restaurant) {
      return NextResponse.json({ error: 'Restaurant introuvable / Restaurant not found' }, { status: 404 })
    }
    if (!restaurant.payment_enabled) {
      return NextResponse.json({ error: 'Paiement non activé pour ce restaurant / Payment not enabled' }, { status: 400 })
    }

    const country = countryFromCity(restaurant.city)
    const mno = detectMNO(phoneNumber, country ?? undefined)
    if (!mno) {
      return NextResponse.json({ error: 'Numéro non supporté / Unsupported phone number' }, { status: 400 })
    }

    const amount = Math.round(Number(order.total_price))
    if (!Number.isFinite(amount) || amount <= 0) {
      return NextResponse.json({ error: 'Montant invalide / Invalid amount' }, { status: 400 })
    }

    let result
    try {
      result = await createDeposit({
        amount,
        currency:    mno.currency,
        phoneNumber,
        orderId:     order.id,
        description: `${restaurant.name} ${order.id.slice(0, 6)}`,
      })
    } catch (e) {
      const msg = (e as Error).message
      console.error('[payments/initiate] createDeposit failed:', msg)
      return NextResponse.json({ error: msg }, { status: 502 })
    }

    // Mark the order pending. order_type stays whatever it was on insert
    // (paid_order from the web checkout), payment_method records the MNO
    // for vendor display.
    await supabaseAdmin
      .from('orders')
      .update({
        payment_status: 'pending',
        payment_id:     result.depositId,
        payment_method: mno.correspondent,
        payment_amount: amount,
      })
      .eq('id', order.id)

    await writeAudit({
      action:          'payment_initiated',
      targetType:      'order',
      targetId:        order.id,
      metadata: {
        deposit_id:    result.depositId,
        correspondent: result.correspondent,
        amount,
        currency:      mno.currency,
      },
    })

    return NextResponse.json({
      ok:           true,
      depositId:    result.depositId,
      status:       result.status,
      mno:          result.correspondent,
      mnoLabel:     mnoLabel(result.correspondent),
      currency:     mno.currency,
      amount,
    })
  } catch (e) {
    console.error('[payments/initiate] internal error:', e)
    return NextResponse.json({ error: 'Erreur interne / Internal error' }, { status: 500 })
  }
}
