import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { sanitizeText } from '@/lib/sanitize'
import { startRefund, type RefundKind } from '@/lib/refunds'

export const dynamic = 'force-dynamic'

// /api/admin/refunds (R2) — SUPER ADMIN ONLY.
// GET  ?kind=order|reservation&id=…  what was paid, refunded, and the refunds
// POST { kind, id, amount, reason, cancel_after? }  start a refund (PawaPay)

function superAdmin(req: NextRequest) {
  const s = getSessionFromRequest(req)
  return s && s.role === 'super_admin' ? s : null
}

async function paymentInfo(kind: RefundKind, id: string) {
  if (kind === 'order') {
    const { data } = await supabaseAdmin.from('orders')
      .select('id, payment_status, payment_id, payment_amount, total_price, refund_status, refunded_amount, customer_phone, status').eq('id', id).maybeSingle()
    if (!data) return null
    return { paid: Math.round(Number(data.payment_amount ?? data.total_price ?? 0)), payment_status: data.payment_status, has_deposit: !!data.payment_id,
      refund_status: data.refund_status, refunded_amount: data.refunded_amount ?? 0, customer_phone: data.customer_phone, status: data.status }
  }
  const { data } = await supabaseAdmin.from('event_reservations')
    .select('id, payment_status, payment_id, total_price, refund_status, refunded_amount, customer_phone, reservation_status').eq('id', id).maybeSingle()
  if (!data) return null
  return { paid: Math.round(Number(data.total_price ?? 0)), payment_status: data.payment_status, has_deposit: !!data.payment_id,
    refund_status: data.refund_status, refunded_amount: data.refunded_amount ?? 0, customer_phone: data.customer_phone, status: data.reservation_status }
}

export async function GET(req: NextRequest) {
  if (!superAdmin(req)) return NextResponse.json({ error: 'Réservé au super admin / Super admin only' }, { status: 403 })
  const kind = req.nextUrl.searchParams.get('kind') as RefundKind
  const id = req.nextUrl.searchParams.get('id') ?? ''
  if (!['order', 'reservation'].includes(kind) || !/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: 'kind + id' }, { status: 400 })
  const info = await paymentInfo(kind, id)
  if (!info) return NextResponse.json({ error: 'Introuvable / Not found' }, { status: 404 })
  const { data: refunds } = await supabaseAdmin.from('refunds').select('*')
    .eq(kind === 'order' ? 'order_id' : 'reservation_id', id).order('created_at', { ascending: false })
  return NextResponse.json({ ...info, refundable: Math.max(0, info.paid - info.refunded_amount), refunds: refunds ?? [] }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(req: NextRequest) {
  const s = superAdmin(req)
  if (!s) return NextResponse.json({ error: 'Réservé au super admin / Super admin only' }, { status: 403 })
  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  const kind = body.kind as RefundKind
  const id = String(body.id ?? '')
  if (!['order', 'reservation'].includes(kind) || !/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: 'kind + id' }, { status: 400 })
  const amount = Number(body.amount)
  if (!Number.isInteger(amount) || amount <= 0) return NextResponse.json({ error: 'Montant invalide (FCFA entiers) / Invalid amount (whole FCFA)', field: 'amount' }, { status: 400 })
  const reason = sanitizeText(body.reason, 300)
  if (reason.length < 3) return NextResponse.json({ error: 'Raison requise / Reason required', field: 'reason' }, { status: 400 })

  const r = await startRefund({ kind, targetId: id, amount, reason, cancelAfter: kind === 'reservation' && body.cancel_after === true, adminId: s.id, adminRole: s.role })
  if (!r.ok) return NextResponse.json({ error: r.error, reason: r.reason, refund: r.refund ?? null }, { status: r.status })
  return NextResponse.json({ ok: true, refund: r.refund, pawapay: r.pawapay })
}
