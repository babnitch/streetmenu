import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { sanitizeText, sanitizePhone, sanitizeCode } from '@/lib/sanitize'
import { rateLimit, rateLimitedResponse, clientIP } from '@/lib/rateLimit'
import { normalizePhone } from '@/lib/phone'
import { priceOrder, PRICE_CHANGED_TEXT } from '@/lib/orderPricing'
import { consumeVoucherForOrder } from '@/lib/vouchers'
import { writeAudit } from '@/lib/audit'

export const dynamic = 'force-dynamic'

// POST /api/orders/create
// Body: { restaurant_id, items: [{ id, quantity }], total_price,
//         customer_name?, customer_phone?, voucher_code?, order_type }
//
// Creates an `orders` row using supabaseAdmin so the call works after
// the RLS lockdown of the orders table. Identity comes from the JWT
// session when present; logged-out callers must include name + phone.
//
// Money is the server's (lib/orderPricing.ts): dish prices from the menu,
// the voucher validated here and used up here. total_price is what the
// checkout showed — when it differs from the server's total the order is
// refused (409, reason price_mismatch, with the current prices).
//
// Returns { ok, order: { id, total_price, … } } on success.
export async function POST(req: NextRequest) {
  const session = getSessionFromRequest(req)

  // 30 order creates per IP per hour — generous for real users (one
  // session might place 2-3), tight for a scripted abuser.
  const limited = rateLimit({ key: `order-create:${clientIP(req)}`, max: 30, windowMs: 3600_000 })
  if (limited) return rateLimitedResponse(limited)

  const body = await req.json().catch(() => ({}))
  const restaurantId = typeof body?.restaurant_id === 'string' ? body.restaurant_id : ''
  if (!restaurantId) {
    return NextResponse.json({ error: 'restaurant_id requis' }, { status: 400 })
  }

  const itemsRaw = Array.isArray(body?.items) ? body.items : []
  if (itemsRaw.length === 0) {
    return NextResponse.json({ error: 'items requis / required' }, { status: 400 })
  }
  // Only which dish and how many are taken from the browser.
  const requested = itemsRaw.map((i: { id?: unknown; quantity?: unknown }) => ({
    id:       typeof i?.id === 'string' ? i.id : '',
    quantity: Math.max(1, Math.min(99, Math.round(Number(i?.quantity ?? 1)) || 1)),
  }))

  // Resolve customer identity. Session wins; logged-out callers supply name+phone.
  let customerId: string | null = null
  let customerName  = ''
  let customerPhone = ''
  if (session?.role === 'customer') {
    customerId = session.id
    const { data: c } = await supabaseAdmin
      .from('customers').select('name, phone').eq('id', session.id).maybeSingle()
    customerName  = c?.name  ?? ''
    customerPhone = c?.phone ?? ''
  } else {
    customerName  = sanitizeText(body?.customer_name, 60)
    customerPhone = normalizePhone(sanitizePhone(body?.customer_phone))
  }
  if (!customerName || !customerPhone) {
    return NextResponse.json({ error: 'Nom et téléphone requis / Name and phone required' }, { status: 400 })
  }

  const voucherCode = body?.voucher_code ? sanitizeCode(body.voucher_code, 32) : null
  const priced = await priceOrder({ restaurantId, items: requested, voucherCode, customerId })
  if (!priced.ok) {
    return NextResponse.json({ error: priced.error, reason: priced.reason, current: priced.current }, { status: priced.status })
  }
  const clientTotal = Math.round(Number(body?.total_price))
  if (!Number.isFinite(clientTotal) || clientTotal !== priced.total) {
    console.warn(`[orders/create] price mismatch restaurant=${restaurantId}: client=${body?.total_price} server=${priced.total}`)
    return NextResponse.json({
      error: PRICE_CHANGED_TEXT, reason: 'price_mismatch', total: priced.total, discount: priced.discount,
      current: priced.lines.map(l => ({ id: l.id, price: l.price, available: true })),
    }, { status: 409 })
  }
  const items = priced.lines
  const orderType: 'reservation' | 'paid_order' = body?.order_type === 'paid_order' ? 'paid_order' : 'reservation'

  const { data: order, error } = await supabaseAdmin
    .from('orders')
    .insert({
      restaurant_id:  restaurantId,
      customer_id:    customerId,
      customer_name:  customerName,
      customer_phone: customerPhone,
      items,
      total_price:    priced.total,
      status:         'pending',
      voucher_code:   priced.voucher?.code ?? null,
      discount_amount: priced.discount > 0 ? priced.discount : null,
      order_type:     orderType,
      payment_status: orderType === 'paid_order' ? 'pending' : 'not_required',
    })
    .select('id, total_price, status, payment_status, order_type')
    .single()

  if (error || !order) {
    console.error('[orders/create] insert failed:', error?.message)
    return NextResponse.json({ error: error?.message ?? 'Erreur' }, { status: 500 })
  }

  // The voucher is used up here, with the order — not by a later call from
  // the browser that could be skipped.
  if (priced.voucher) {
    await consumeVoucherForOrder(priced.voucher.id, customerId, order.id)
    await writeAudit({
      action: 'voucher_applied', targetType: 'voucher', targetId: priced.voucher.id,
      performedBy: customerId ?? order.id, performedByType: customerId ? 'customer' : 'guest',
      metadata: { order_id: order.id, restaurant_id: restaurantId, code: priced.voucher.code, discount: priced.discount },
    })
  }
  return NextResponse.json({ ok: true, order })
}
