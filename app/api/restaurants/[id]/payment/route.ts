import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'

export const dynamic = 'force-dynamic'

// PATCH { payment_enabled, pawapay_merchant_id? } — owner toggles online
// payment for their restaurant. We accept POST too because the rest of the
// vendor APIs in this file tree already use POST for owner-side mutations.
async function update(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionFromRequest(req)
  if (!session) return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })

  // Owner-only — managers and staff can run the kitchen but shouldn't be
  // able to flip the payment configuration.
  const isAdmin = ['super_admin', 'admin'].includes(session.role)
  if (!isAdmin) {
    if (session.role !== 'customer') {
      return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
    }
    const { data: team } = await supabaseAdmin
      .from('restaurant_team').select('role')
      .eq('restaurant_id', params.id).eq('customer_id', session.id).eq('status', 'active').maybeSingle()
    if (!team || team.role !== 'owner') {
      return NextResponse.json({ error: 'Non autorisé / Not authorized' }, { status: 403 })
    }
  }

  let body: { payment_enabled?: boolean; pawapay_merchant_id?: string | null }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'invalid json' }, { status: 400 }) }

  if (typeof body.payment_enabled !== 'boolean' && body.pawapay_merchant_id === undefined) {
    return NextResponse.json({ error: 'Aucune modification / No changes' }, { status: 400 })
  }

  const { data: before } = await supabaseAdmin
    .from('restaurants')
    .select('payment_enabled, pawapay_merchant_id')
    .eq('id', params.id)
    .maybeSingle()
  if (!before) return NextResponse.json({ error: 'Restaurant introuvable / not found' }, { status: 404 })

  const updates: Record<string, unknown> = {}
  if (typeof body.payment_enabled === 'boolean')      updates.payment_enabled     = body.payment_enabled
  if (body.pawapay_merchant_id !== undefined)         updates.pawapay_merchant_id = body.pawapay_merchant_id

  const { error } = await supabaseAdmin
    .from('restaurants')
    .update(updates)
    .eq('id', params.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await writeAudit({
    action:           typeof body.payment_enabled === 'boolean'
                        ? (body.payment_enabled ? 'payment_enabled' : 'payment_disabled')
                        : 'payment_settings_updated',
    targetType:       'restaurant',
    targetId:         params.id,
    performedBy:      session.id,
    performedByType:  session.role,
    previousData:     { payment_enabled: before.payment_enabled, pawapay_merchant_id: before.pawapay_merchant_id },
    metadata:         updates,
  })

  return NextResponse.json({ ok: true, ...updates })
}

export const PATCH = update
export const POST  = update
