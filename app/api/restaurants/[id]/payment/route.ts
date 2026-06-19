import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'
import { PAYMENT_MODES, normalizeMode, legacyEnabledFromMode, type PaymentMode } from '@/lib/paymentMode'

export const dynamic = 'force-dynamic'

// PATCH { payment_mode?, whatsapp_payment_enabled?, pawapay_merchant_id? } —
// owner (or admin) sets the payment configuration for their restaurant. We
// accept POST too because the rest of the vendor APIs in this file tree already
// use POST for owner-side mutations.
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

  let body: { payment_mode?: string; whatsapp_payment_enabled?: boolean; pawapay_merchant_id?: string | null }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'invalid json' }, { status: 400 }) }

  const hasMode     = typeof body.payment_mode === 'string'
  const hasWhatsapp = typeof body.whatsapp_payment_enabled === 'boolean'
  const hasMerchant = body.pawapay_merchant_id !== undefined
  if (!hasMode && !hasWhatsapp && !hasMerchant) {
    return NextResponse.json({ error: 'Aucune modification / No changes' }, { status: 400 })
  }
  if (hasMode && !PAYMENT_MODES.includes(body.payment_mode as PaymentMode)) {
    return NextResponse.json({ error: 'payment_mode invalide / invalid' }, { status: 400 })
  }

  const { data: before } = await supabaseAdmin
    .from('restaurants')
    .select('payment_mode, whatsapp_payment_enabled, payment_enabled, pawapay_merchant_id')
    .eq('id', params.id)
    .maybeSingle()
  if (!before) return NextResponse.json({ error: 'Restaurant introuvable / not found' }, { status: 404 })

  const updates: Record<string, unknown> = {}
  if (hasMode) {
    const mode = normalizeMode(body.payment_mode)
    updates.payment_mode    = mode
    updates.payment_enabled = legacyEnabledFromMode(mode) // keep legacy column in sync
    // Online payment off entirely → WhatsApp payment can't stand on its own.
    if (mode === 'reservation_only') updates.whatsapp_payment_enabled = false
  }
  if (hasWhatsapp && updates.whatsapp_payment_enabled === undefined) {
    updates.whatsapp_payment_enabled = body.whatsapp_payment_enabled
  }
  if (hasMerchant) updates.pawapay_merchant_id = body.pawapay_merchant_id

  const { error } = await supabaseAdmin
    .from('restaurants')
    .update(updates)
    .eq('id', params.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await writeAudit({
    action:           'payment_settings_updated',
    targetType:       'restaurant',
    targetId:         params.id,
    performedBy:      session.id,
    performedByType:  session.role,
    previousData:     {
      payment_mode:             before.payment_mode,
      whatsapp_payment_enabled: before.whatsapp_payment_enabled,
      pawapay_merchant_id:      before.pawapay_merchant_id,
    },
    metadata:         updates,
  })

  return NextResponse.json({ ok: true, ...updates })
}

export const PATCH = update
export const POST  = update
