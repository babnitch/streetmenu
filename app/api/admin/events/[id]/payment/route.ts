import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'
import { PAYMENT_MODES, normalizeMode, legacyEnabledFromMode, canPayOnline, type PaymentMode } from '@/lib/paymentMode'

export const dynamic = 'force-dynamic'

// PATCH { payment_mode?, whatsapp_payment_enabled? } — super_admin / admin set
// the payment configuration for an event. Moderators may read the admin
// dashboard but must NOT change the payment configuration. Free events are
// always reservation_only — enabling an online-payment mode is rejected.
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
    .from('events')
    .select('payment_mode, whatsapp_payment_enabled, title, ticket_price')
    .eq('id', params.id)
    .maybeSingle()
  if (!before) return NextResponse.json({ error: 'Événement introuvable / not found' }, { status: 404 })

  const isFree = !(Number(before.ticket_price ?? 0) > 0)

  const updates: Record<string, unknown> = {}
  if (hasMode) {
    const mode = normalizeMode(body.payment_mode)
    if (isFree && canPayOnline(mode)) {
      return NextResponse.json({ error: 'Billet gratuit — paiement impossible / Free ticket — no payment' }, { status: 400 })
    }
    updates.payment_mode    = mode
    updates.payment_enabled = legacyEnabledFromMode(mode)
    if (mode === 'reservation_only') updates.whatsapp_payment_enabled = false
  }
  if (hasWhatsapp && updates.whatsapp_payment_enabled === undefined) {
    if (body.whatsapp_payment_enabled && isFree) {
      return NextResponse.json({ error: 'Billet gratuit — paiement impossible / Free ticket — no payment' }, { status: 400 })
    }
    updates.whatsapp_payment_enabled = body.whatsapp_payment_enabled
  }

  const { error } = await supabaseAdmin
    .from('events')
    .update(updates)
    .eq('id', params.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await writeAudit({
    action:          'event_payment_settings_updated',
    targetType:      'event',
    targetId:        params.id,
    performedBy:     session.id,
    performedByType: session.role,
    previousData:    { payment_mode: before.payment_mode, whatsapp_payment_enabled: before.whatsapp_payment_enabled, title: before.title },
    metadata:        { ...updates, by: 'admin' },
  })

  return NextResponse.json({ ok: true, ...updates })
}
