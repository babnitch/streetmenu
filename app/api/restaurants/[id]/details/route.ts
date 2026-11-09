import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { getSessionFromRequest } from '@/lib/auth'
import { writeAudit } from '@/lib/audit'
import { getRefData } from '@/lib/refDataServer'
import { recordProposal } from '@/lib/refChoice'
import { isRestaurantOwner } from '@/lib/vendorAccess'
import { checkRestaurantDetails, DETAIL_FIELDS, NOTICE_FIELDS, type DetailRow } from '@/lib/restaurantDetails'

export const dynamic = 'force-dynamic'

// POST /api/restaurants/[id]/details — the OWNER edits the restaurant's own
// details (lib/restaurantDetails.ts). Live at once, no new approval. Audited
// (restaurant_details_changed, old → new). A change customers rely on (name,
// address, pin, city, area, phones) is also listed for the admins
// (restaurant_change_notices → Admin → Restaurants). Owner only (implicit or
// team owner); a deleted restaurant can't be changed.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = getSessionFromRequest(req)
  if (!session || session.role !== 'customer') {
    return NextResponse.json({ error: 'Non autorisé / Unauthorized' }, { status: 401 })
  }
  if (!/^[0-9a-f-]{36}$/i.test(params.id)) return NextResponse.json({ error: 'Introuvable / Not found' }, { status: 404 })
  if (!(await isRestaurantOwner(params.id, session.id))) {
    return NextResponse.json({ error: 'Réservé au propriétaire / Owner only' }, { status: 403 })
  }
  const { data: row } = await supabaseAdmin.from('restaurants').select(`id, ${DETAIL_FIELDS.join(', ')}`)
    .eq('id', params.id).is('deleted_at', null).maybeSingle()
  if (!row) return NextResponse.json({ error: 'Introuvable / Not found' }, { status: 404 })
  const current = row as unknown as DetailRow & { id: string }

  await getRefData()
  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  const check = checkRestaurantDetails(body, current)
  if (!check.ok) return NextResponse.json({ error: check.error, field: check.field }, { status: 400 })
  const fields = Object.keys(check.patch) as Array<keyof DetailRow>
  if (!fields.length) return NextResponse.json({ ok: true, restaurant: current, changed: [] })

  // The WhatsApp number is how the bot finds the restaurant: one restaurant per number.
  if (check.patch.whatsapp) {
    const { data: taken } = await supabaseAdmin.from('restaurants').select('id')
      .eq('whatsapp', check.patch.whatsapp).neq('id', current.id).is('deleted_at', null).limit(1)
    if (taken?.length) return NextResponse.json({ error: 'Ce numéro WhatsApp est déjà utilisé par un autre restaurant / This WhatsApp number is already used by another restaurant', field: 'whatsapp' }, { status: 409 })
  }

  const { data: saved, error } = await supabaseAdmin.from('restaurants').update(check.patch)
    .eq('id', current.id).is('deleted_at', null).select('*').maybeSingle()
  if (error || !saved) {
    console.error('[restaurants/details] update failed:', error?.message)
    return NextResponse.json({ error: 'Erreur serveur / Server error' }, { status: 500 })
  }

  const changes = Object.fromEntries(fields.map(f => [f, { old: current[f] ?? null, new: check.patch[f] ?? null }]))
  await writeAudit({
    action: 'restaurant_details_changed', targetType: 'restaurant', targetId: current.id,
    performedBy: session.id, performedByType: 'owner',
    previousData: Object.fromEntries(fields.map(f => [f, current[f] ?? null])),
    metadata: { changes },
  })
  if (check.cuisineProposed) {
    await recordProposal({ kind: 'cuisine', proposed: check.cuisineProposed, by: session.id, targetType: 'restaurant', targetId: current.id, savedAs: String(check.patch.cuisine_type ?? '') })
  }
  const noticed = fields.filter(f => NOTICE_FIELDS.includes(f))
  if (noticed.length) {
    const { error: nErr } = await supabaseAdmin.from('restaurant_change_notices').insert({
      restaurant_id: current.id, changed_by: session.id,
      changes: Object.fromEntries(noticed.map(f => [f, changes[f]])),
    })
    if (nErr) console.error('[restaurants/details] notice insert failed:', nErr.message)
  }
  return NextResponse.json({ ok: true, restaurant: saved, changed: fields })
}
