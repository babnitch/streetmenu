import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'
import { PAYMENT_MODES, normalizeMode, legacyEnabledFromMode, type PaymentMode } from '@/lib/paymentMode'

export const dynamic = 'force-dynamic'

// PATCH { payment_mode?, whatsapp_payment_enabled? } — super_admin / admin set
// the payment configuration for any restaurant. Moderators may read the admin
// dashboard but must NOT change the payment configuration.
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionFromRequest(req)
  if (!session) return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })

  if (!['super_admin', 'admin'].includes(session.role)) {
    return NextResponse.json({ error: 'Permission insuffisante / Insufficient permission' }, { status: 403 })
  }

  let body: { payment_mode?: string; whatsapp_payment_enabled?: boolean }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'invalid json' }, { status: 400 }) }

  const hasMode     = typeof body.payment_mode === 'string'
  const hasWhatsapp = typeof body.whatsapp_payment_enabled === 'boolean'
  if (!hasMode && !hasWhatsapp) {
    return NextResponse.json({ error: 'Aucune modification / No changes' }, { status: 400 })
  }
  if (hasMode && !PAYMENT_MODES.includes(body.payment_mode as PaymentMode)) {
    return NextResponse.json({ error: 'payment_mode invalide / invalid' }, { status: 400 })
  }

  const { data: before } = await supabaseAdmin
    .from('restaurants')
    .select('payment_mode, whatsapp_payment_enabled, name')
    .eq('id', params.id)
    .maybeSingle()
  if (!before) return NextResponse.json({ error: 'Restaurant introuvable / not found' }, { status: 404 })

  const updates: Record<string, unknown> = {}
  if (hasMode) {
    const mode = normalizeMode(body.payment_mode)
    updates.payment_mode    = mode
    updates.payment_enabled = legacyEnabledFromMode(mode)
    if (mode === 'reservation_only') updates.whatsapp_payment_enabled = false
  }
  if (hasWhatsapp && updates.whatsapp_payment_enabled === undefined) {
    updates.whatsapp_payment_enabled = body.whatsapp_payment_enabled
  }

  const { error } = await supabaseAdmin
    .from('restaurants')
    .update(updates)
    .eq('id', params.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await writeAudit({
    action:          'payment_settings_updated',
    targetType:      'restaurant',
    targetId:        params.id,
    performedBy:     session.id,
    performedByType: session.role,
    previousData:    { payment_mode: before.payment_mode, whatsapp_payment_enabled: before.whatsapp_payment_enabled, name: before.name },
    metadata:        { ...updates, by: 'admin' },
  })

  return NextResponse.json({ ok: true, ...updates })
}
