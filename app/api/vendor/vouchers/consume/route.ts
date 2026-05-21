import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'

export const dynamic = 'force-dynamic'

// POST /api/vendor/vouchers/consume
// Body: { customer_voucher_id }
//
// Vendor-side: after the validate flow shows the voucher is good,
// tapping "Confirm" hits this route to mark the customer_voucher used
// and bump the parent voucher's uses_count. Previously these writes
// happened directly from the browser via the anon Supabase client —
// that broke when supabase-rls-policies.sql locked the tables down,
// and was also a privilege issue (any client could mark any voucher
// used).
//
// Authz: caller must be a logged-in customer who is also on the active
// team of at least one restaurant.
export async function POST(req: NextRequest) {
  const session = getSessionFromRequest(req)
  if (!session || session.role !== 'customer') {
    return NextResponse.json({ error: 'Connexion requise / Login required' }, { status: 401 })
  }

  // Vendor gate — anyone on at least one restaurant_team row.
  const { data: teamRows } = await supabaseAdmin
    .from('restaurant_team').select('restaurant_id')
    .eq('customer_id', session.id).eq('status', 'active').limit(1)
  if (!teamRows || teamRows.length === 0) {
    return NextResponse.json({ error: 'Réservé aux vendeurs / Vendor-only' }, { status: 403 })
  }

  const body = await req.json().catch(() => ({}))
  const cvId = typeof body?.customer_voucher_id === 'string' ? body.customer_voucher_id : ''
  if (!cvId) {
    return NextResponse.json({ error: 'customer_voucher_id requis' }, { status: 400 })
  }

  const { data: cv } = await supabaseAdmin
    .from('customer_vouchers').select('id, voucher_id, used_at').eq('id', cvId).maybeSingle()
  if (!cv)            return NextResponse.json({ error: 'Bon introuvable / Voucher not found' }, { status: 404 })
  if (cv.used_at)     return NextResponse.json({ error: 'Bon déjà utilisé / Already used' }, { status: 409 })

  // Two-step (read → update) because Supabase's PostgREST client
  // doesn't expose RETURNING for atomic increments; collision risk
  // is acceptable at this scale (vendors operate one transaction at
  // a time on the dashboard).
  await supabaseAdmin
    .from('customer_vouchers').update({ used_at: new Date().toISOString() }).eq('id', cv.id)
  const { data: v } = await supabaseAdmin
    .from('vouchers').select('uses_count').eq('id', cv.voucher_id).maybeSingle()
  if (v) {
    await supabaseAdmin
      .from('vouchers')
      .update({ uses_count: (v.uses_count ?? 0) + 1 })
      .eq('id', cv.voucher_id)
  }

  return NextResponse.json({ ok: true })
}
