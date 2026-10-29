import { requireProMode } from '@/lib/proModeServer'
import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { rateLimit } from '@/lib/rateLimit'
import { assignedRiderId } from '@/lib/riders'
import { deliveryCode } from '@/lib/scanTokens'
import { markOrderDelivered } from '@/lib/orderDelivery'

export const dynamic = 'force-dynamic'

// POST /api/rider/orders/[id]/deliver { code } (Q5) — the assigned rider
// types the customer's secret delivery code → "Livrée"
// (delivered_confirmed_by = rider, delivered_by_rider). Scanning the
// customer's QR goes through /api/scan/<token> instead. 10 tries / 10 min.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionFromRequest(req)
  if (!session || session.role !== 'customer') return NextResponse.json({ error: 'Connexion requise / Login required' }, { status: 401 })
  const notPro = await requireProMode(session)
  if (notPro) return notPro
  const hit = rateLimit({ key: `rider:code:${session.id}:${params.id}`, max: 10, windowMs: 600_000 })
  if (hit) return NextResponse.json({ error: hit.message }, { status: 429 })
  const { data: o } = await supabaseAdmin.from('orders').select('id, rider_id').eq('id', params.id).maybeSingle()
  const riderId = o ? await assignedRiderId(o as { rider_id: string | null }, session.id) : null
  if (!o || !riderId) return NextResponse.json({ error: 'Commande introuvable / Order not found' }, { status: 404 })
  const body = await req.json().catch(() => ({})) as { code?: unknown }
  const code = String(body.code ?? '').replace(/\D/g, '')
  if (code !== deliveryCode(o.id as string)) {
    return NextResponse.json({ error: 'Code incorrect — demandez le code de livraison au client / Wrong code — ask the customer for the delivery code' }, { status: 400 })
  }
  const r = await markOrderDelivered(o.id as string, 'rider', { id: session.id, type: 'customer' }, { riderId, notify: 'customer' })
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 409 })
  return NextResponse.json({ ok: true })
}
