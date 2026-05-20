import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'

export const dynamic = 'force-dynamic'

// Shared authz helper: caller must be the event's organizer or an admin
// of any role; otherwise 403. Returns the resolved tier row for the
// caller to mutate.
async function authorize(req: NextRequest, eventId: string, tierId: string) {
  const session = getSessionFromRequest(req)
  if (!session) return { error: NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 }) }
  const isAdmin = ['super_admin', 'admin', 'moderator'].includes(session.role)

  const { data: event } = await supabaseAdmin
    .from('events').select('id, organizer_id').eq('id', eventId).maybeSingle()
  if (!event) return { error: NextResponse.json({ error: 'Événement introuvable / Event not found' }, { status: 404 }) }
  if (!isAdmin && event.organizer_id !== session.id) {
    return { error: NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 403 }) }
  }

  const { data: tier } = await supabaseAdmin
    .from('event_ticket_tiers').select('*').eq('id', tierId).eq('event_id', eventId).maybeSingle()
  if (!tier) return { error: NextResponse.json({ error: 'Tarif introuvable / Tier not found' }, { status: 404 }) }

  return { session, event, tier }
}

// PATCH /api/events/[id]/tiers/[tierId]
// Body: any subset of { name, name_en, price, max_quantity, sort_order,
//                       sales_start, sales_end, description, is_active }
// Updates only the provided fields. updated_at is bumped automatically.
export async function PATCH(req: NextRequest, { params }: { params: { id: string; tierId: string } }) {
  const auth = await authorize(req, params.id, params.tierId)
  if ('error' in auth) return auth.error
  const { session, tier } = auth

  const body = await req.json().catch(() => ({}))
  const updates: Record<string, unknown> = {}
  if (typeof body?.name === 'string')         updates.name = body.name.trim()
  if ('name_en' in body)                       updates.name_en = body.name_en ? String(body.name_en).trim() : null
  if (Number.isFinite(body?.price))            updates.price = Math.max(0, Math.round(body.price))
  if (Number.isFinite(body?.max_quantity))     updates.max_quantity = Math.max(0, Math.round(body.max_quantity))
  if (Number.isFinite(body?.sort_order))       updates.sort_order = Math.round(body.sort_order)
  if ('sales_start' in body)                   updates.sales_start = body.sales_start ? String(body.sales_start) : null
  if ('sales_end'   in body)                   updates.sales_end   = body.sales_end   ? String(body.sales_end)   : null
  if ('description' in body)                   updates.description = body.description ? String(body.description).trim() : null
  if (typeof body?.is_active === 'boolean')    updates.is_active = body.is_active
  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'Aucun champ à mettre à jour' }, { status: 400 })
  }
  updates.updated_at = new Date().toISOString()

  const { error } = await supabaseAdmin
    .from('event_ticket_tiers').update(updates).eq('id', tier.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await writeAudit({
    action:          'tier_updated',
    targetType:      'event',
    targetId:        tier.event_id,
    performedBy:     session.id,
    performedByType: session.role,
    previousData:    { name: tier.name, price: tier.price, max_quantity: tier.max_quantity, is_active: tier.is_active },
    metadata:        { tier_id: tier.id, ...updates },
  })

  return NextResponse.json({ ok: true })
}

// DELETE /api/events/[id]/tiers/[tierId]
// Soft-delete only — never destructive when the tier has already sold
// tickets, because that would orphan the related reservation rows'
// references. We just flip is_active=false; the tier disappears from
// the public picker but stays attached to historical reservations.
export async function DELETE(req: NextRequest, { params }: { params: { id: string; tierId: string } }) {
  const auth = await authorize(req, params.id, params.tierId)
  if ('error' in auth) return auth.error
  const { session, tier } = auth

  await supabaseAdmin
    .from('event_ticket_tiers')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('id', tier.id)

  await writeAudit({
    action:          'tier_deactivated',
    targetType:      'event',
    targetId:        tier.event_id,
    performedBy:     session.id,
    performedByType: session.role,
    previousData:    { is_active: tier.is_active },
    metadata:        { tier_id: tier.id, sold_count: tier.sold_count },
  })

  return NextResponse.json({ ok: true })
}
