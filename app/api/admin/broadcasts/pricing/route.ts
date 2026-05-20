import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'

export const dynamic = 'force-dynamic'

// GET /api/admin/broadcasts/pricing — current active pricing row.
// PATCH — update price_per_recipient / min_charge / max_message_length.
// Body: { price_per_recipient?: number, min_charge?: number, max_message_length?: number }
//
// Single-row config: PATCH writes back to the active row. If no active row
// exists (fresh DB) one is created with the supplied values + defaults.
export async function GET(req: NextRequest) {
  const session = getSessionFromRequest(req)
  if (!session || !['super_admin', 'admin', 'moderator'].includes(session.role)) {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }
  const { data } = await supabaseAdmin
    .from('broadcast_pricing')
    .select('id, price_per_recipient, min_charge, max_message_length, is_active, created_at')
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return NextResponse.json({ pricing: data ?? null })
}

export async function PATCH(req: NextRequest) {
  const session = getSessionFromRequest(req)
  if (!session || !['super_admin', 'admin'].includes(session.role)) {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }
  const body = await req.json().catch(() => ({}))
  const updates: Record<string, unknown> = {}
  if (Number.isFinite(body?.price_per_recipient)) updates.price_per_recipient = Math.max(0, Math.round(body.price_per_recipient))
  if (Number.isFinite(body?.min_charge))          updates.min_charge          = Math.max(0, Math.round(body.min_charge))
  if (Number.isFinite(body?.max_message_length))  updates.max_message_length  = Math.max(10, Math.min(4000, Math.round(body.max_message_length)))

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'Aucun champ à mettre à jour / No fields to update' }, { status: 400 })
  }

  const { data: existing } = await supabaseAdmin
    .from('broadcast_pricing')
    .select('id, price_per_recipient, min_charge, max_message_length')
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (existing) {
    const { error } = await supabaseAdmin
      .from('broadcast_pricing')
      .update(updates)
      .eq('id', existing.id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    await writeAudit({
      action:          'broadcast_pricing_updated',
      targetType:      'admin_user',
      targetId:        existing.id,
      performedBy:     session.id,
      performedByType: session.role,
      previousData:    existing,
      metadata:        updates,
    })
  } else {
    const { data: inserted, error } = await supabaseAdmin
      .from('broadcast_pricing')
      .insert({ ...updates, is_active: true })
      .select('id')
      .single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    await writeAudit({
      action:          'broadcast_pricing_created',
      targetType:      'admin_user',
      targetId:        inserted!.id,
      performedBy:     session.id,
      performedByType: session.role,
      metadata:        updates,
    })
  }

  return NextResponse.json({ ok: true })
}
