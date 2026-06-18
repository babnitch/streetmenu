import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'
import { sendWhatsApp, getLangByPhone, pickLang } from '@/lib/whatsapp'

export const dynamic = 'force-dynamic'

type ManualMethod = 'cash' | 'mtn_momo' | 'orange_money'
const METHOD_LABELS: Record<ManualMethod, { fr: string; en: string }> = {
  cash:         { fr: 'Espèces',      en: 'Cash' },
  mtn_momo:     { fr: 'MTN MoMo',     en: 'MTN MoMo' },
  orange_money: { fr: 'Orange Money', en: 'Orange Money' },
}

function isManualMethod(v: unknown): v is ManualMethod {
  return v === 'cash' || v === 'mtn_momo' || v === 'orange_money'
}

// POST /api/orders/[id]/mark-paid
// Body: { method: 'cash' | 'mtn_momo' | 'orange_money', payer_phone?: string }
//
// Vendor (owner / manager) marks an order paid out-of-band — covers cash on
// pickup, manual mobile-money transfers, or any settlement that bypassed
// PawaPay's in-app deposit. Refuses orders that already carry a PawaPay
// transaction id, since those reflect a real on-platform deposit that
// shouldn't be overwritten.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionFromRequest(req)
  if (!session) {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }

  const body = await req.json().catch(() => ({}))
  const method     = body?.method
  const payerPhone = typeof body?.payer_phone === 'string' ? body.payer_phone.trim() : ''
  if (!isManualMethod(method)) {
    return NextResponse.json({ error: 'Méthode invalide / Invalid method' }, { status: 400 })
  }
  if ((method === 'mtn_momo' || method === 'orange_money') && !payerPhone) {
    return NextResponse.json({
      error: 'Numéro requis pour MoMo / Phone number required for MoMo',
    }, { status: 400 })
  }

  const { data: order, error: orderErr } = await supabaseAdmin
    .from('orders')
    .select('id, restaurant_id, customer_name, customer_phone, total_price, payment_status, payment_id')
    .eq('id', params.id)
    .maybeSingle()

  if (orderErr || !order) {
    return NextResponse.json({ error: 'Commande introuvable / Order not found' }, { status: 404 })
  }

  // App-paid orders carry a PawaPay deposit id. Refuse to overwrite — the
  // payment is real, and a manual override here would silently lose the
  // PawaPay reconciliation trail.
  if (order.payment_id) {
    return NextResponse.json({
      error: 'Commande déjà payée dans l\'app / Order already paid in-app',
    }, { status: 409 })
  }
  if (order.payment_status === 'paid') {
    return NextResponse.json({ error: 'Commande déjà payée / Already paid' }, { status: 409 })
  }

  // Authz: owner or manager of this restaurant only. Admins bypass.
  const isAdmin = ['super_admin', 'admin', 'moderator'].includes(session.role)
  let allowed = isAdmin
  if (!allowed) {
    const { data: team } = await supabaseAdmin
      .from('restaurant_team')
      .select('role')
      .eq('restaurant_id', order.restaurant_id)
      .eq('customer_id', session.id)
      .eq('status', 'active')
      .maybeSingle()
    if (team?.role === 'owner' || team?.role === 'manager') {
      allowed = true
    } else {
      // Legacy fallback — restaurants.customer_id without an explicit team row
      const { data: rest } = await supabaseAdmin
        .from('restaurants').select('customer_id')
        .eq('id', order.restaurant_id).maybeSingle()
      if (rest?.customer_id === session.id) allowed = true
    }
  }
  if (!allowed) {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 403 })
  }

  const previousStatus = order.payment_status
  const { error: updErr } = await supabaseAdmin
    .from('orders')
    .update({
      payment_status:       'paid',
      payment_method:       method,
      payment_at:           new Date().toISOString(),
      payment_amount:       Math.round(Number(order.total_price)),
      manual_payment_phone: payerPhone || null,
      updated_at:           new Date().toISOString(),
    })
    .eq('id', order.id)

  if (updErr) {
    console.error('[mark-paid] update failed:', updErr.message)
    // manual_payment_phone column missing → migration not applied
    const hint = /manual_payment_phone|column .* does not exist/i.test(updErr.message)
      ? ' (run supabase-manual-payment.sql)'
      : ''
    return NextResponse.json({ error: updErr.message + hint }, { status: 500 })
  }

  await writeAudit({
    action:          'payment_marked_paid',
    targetType:      'order',
    targetId:        order.id,
    performedBy:     session.id,
    performedByType: isAdmin ? session.role : 'vendor',
    previousData:    { payment_status: previousStatus },
    metadata: {
      method,
      payer_phone:  payerPhone || null,
      marked_by:    session.id,
    },
  })

  const { data: restaurant } = await supabaseAdmin
    .from('restaurants').select('name').eq('id', order.restaurant_id).maybeSingle()
  const restName = restaurant?.name ?? '—'
  const id4 = order.id.replace(/-/g, '').slice(-4).toUpperCase()

  if (order.customer_phone) {
    const label = METHOD_LABELS[method]
    const lang = await getLangByPhone(order.customer_phone)
    const r = await sendWhatsApp(order.customer_phone, [
      pickLang(`💰 *Paiement confirmé par ${restName}*`, `💰 *Payment confirmed by ${restName}*`, lang),
      ``,
      pickLang(`🧾 Commande #${id4}`, `🧾 Order #${id4}`, lang),
      `💳 ${pickLang(label.fr, label.en, lang)}`,
      `💰 ${Number(order.total_price).toLocaleString()} FCFA`,
      ``,
      pickLang(`Merci!`, `Thank you!`, lang),
    ].join('\n'))
    console.log(`[mark-paid] customer notification: order=${order.id} ok=${r.ok} sid=${r.sid ?? '-'} twilioStatus=${r.twilioStatus ?? '-'}`)
  }

  return NextResponse.json({
    ok:             true,
    payment_status: 'paid',
    payment_method: method,
  })
}
