import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { sanitizeText, sanitizePhone, sanitizeCode } from '@/lib/sanitize'
import { rateLimit, rateLimitedResponse, clientIP } from '@/lib/rateLimit'
import { normalizePhone } from '@/lib/phone'

export const dynamic = 'force-dynamic'

// POST /api/orders/create
// Body: { restaurant_id, items, total_price, customer_name?, customer_phone?,
//         voucher_code?, discount_amount?, order_type }
//
// Creates an `orders` row using supabaseAdmin so the call works after
// the RLS lockdown of the orders table. Identity comes from the JWT
// session when present; logged-out callers must include name + phone.
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
  // Whitelist the keys we accept on each cart line so an attacker
  // can't sneak extra columns into the JSONB blob.
  const items = itemsRaw.map((i: { id?: unknown; name?: unknown; price?: unknown; quantity?: unknown; photo_url?: unknown }) => ({
    id:        typeof i?.id === 'string' ? i.id : '',
    name:      sanitizeText(i?.name, 120),
    price:     Math.max(0, Math.round(Number(i?.price ?? 0)) || 0),
    quantity:  Math.max(1, Math.min(99, Math.round(Number(i?.quantity ?? 1)) || 1)),
    photo_url: typeof i?.photo_url === 'string' ? i.photo_url : null,
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

  const totalPrice    = Math.max(0, Math.round(Number(body?.total_price ?? 0)) || 0)
  const discountAmount = Number.isFinite(body?.discount_amount) && body.discount_amount > 0
    ? Math.round(body.discount_amount)
    : null
  const voucherCode = body?.voucher_code ? sanitizeCode(body.voucher_code, 32) : null
  const orderType: 'reservation' | 'paid_order' = body?.order_type === 'paid_order' ? 'paid_order' : 'reservation'

  const { data: order, error } = await supabaseAdmin
    .from('orders')
    .insert({
      restaurant_id:  restaurantId,
      customer_id:    customerId,
      customer_name:  customerName,
      customer_phone: customerPhone,
      items,
      total_price:    totalPrice,
      status:         'pending',
      voucher_code:   voucherCode,
      discount_amount: discountAmount,
      order_type:     orderType,
      payment_status: orderType === 'paid_order' ? 'pending' : 'not_required',
    })
    .select('id, total_price, status, payment_status, order_type')
    .single()

  if (error || !order) {
    console.error('[orders/create] insert failed:', error?.message)
    return NextResponse.json({ error: error?.message ?? 'Erreur' }, { status: 500 })
  }
  return NextResponse.json({ ok: true, order })
}
