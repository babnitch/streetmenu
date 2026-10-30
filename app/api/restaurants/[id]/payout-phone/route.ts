import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { requestPayoutPhone } from '@/lib/proPayouts'

export const dynamic = 'force-dynamic'

// POST /api/restaurants/[id]/payout-phone { phone } — the owner asks to be
// paid on another Mobile Money number. It waits for an admin's confirmation
// (Admin → Commandes → À payer), so a hijacked account can't redirect money.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionFromRequest(req)
  if (!session || session.role !== 'customer') return NextResponse.json({ error: 'Connexion requise / Login required' }, { status: 401 })
  const { data: direct } = await supabaseAdmin.from('restaurants').select('id').eq('id', params.id).eq('customer_id', session.id).maybeSingle()
  const { data: team } = direct ? { data: true } : await supabaseAdmin.from('restaurant_team').select('id')
    .eq('restaurant_id', params.id).eq('customer_id', session.id).eq('status', 'active').eq('role', 'owner').maybeSingle()
  if (!direct && !team) return NextResponse.json({ error: 'Réservé au propriétaire / Owner only' }, { status: 403 })
  const body = await req.json().catch(() => ({})) as { phone?: unknown }
  const r = await requestPayoutPhone(params.id, String(body.phone ?? ''), { id: session.id, type: 'vendor' })
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status })
  return NextResponse.json({ ok: true, pending: true })
}
