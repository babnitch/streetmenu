// Saving a restaurant's details (lib/restaurantDetails.ts) — shared by the
// owner route (/api/restaurants/[id]/details) and the admin route
// (/api/admin/restaurants/[id]/info). Same checks for both: a city we serve,
// the pin inside it, one restaurant per WhatsApp number. Audited
// (restaurant_details_changed, old → new). Only an OWNER's change to name /
// address / pin / city / area / phones is listed for the admins.

import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { writeAudit } from '@/lib/audit'
import { getRefData } from '@/lib/refDataServer'
import { recordProposal } from '@/lib/refChoice'
import { checkRestaurantDetails, DETAIL_FIELDS, NOTICE_FIELDS, type DetailRow } from '@/lib/restaurantDetails'

export type SaveDetailsResult =
  | { ok: true; restaurant: Record<string, unknown>; changed: string[] }
  | { ok: false; status: number; error: string; field?: string }

export async function saveRestaurantDetails(input: {
  restaurantId: string
  body: Record<string, unknown>
  actor: { id: string; type: 'owner' | 'super_admin' | 'admin' }
}): Promise<SaveDetailsResult> {
  const { restaurantId, body, actor } = input
  const { data: row } = await supabaseAdmin.from('restaurants').select(`id, ${DETAIL_FIELDS.join(', ')}`)
    .eq('id', restaurantId).is('deleted_at', null).maybeSingle()
  if (!row) return { ok: false, status: 404, error: 'Introuvable / Not found' }
  const current = row as unknown as DetailRow & { id: string }

  await getRefData()
  const check = checkRestaurantDetails(body, current)
  if (!check.ok) return { ok: false, status: 400, error: check.error, field: check.field }
  const fields = Object.keys(check.patch) as Array<keyof DetailRow>
  if (!fields.length) return { ok: true, restaurant: current, changed: [] }

  // The WhatsApp number is how the bot finds the restaurant: one restaurant per number.
  if (check.patch.whatsapp) {
    const { data: taken } = await supabaseAdmin.from('restaurants').select('id')
      .eq('whatsapp', check.patch.whatsapp).neq('id', current.id).is('deleted_at', null).limit(1)
    if (taken?.length) return { ok: false, status: 409, field: 'whatsapp', error: 'Ce numéro WhatsApp est déjà utilisé par un autre restaurant / This WhatsApp number is already used by another restaurant' }
  }

  const { data: saved, error } = await supabaseAdmin.from('restaurants').update(check.patch)
    .eq('id', current.id).is('deleted_at', null).select('*').maybeSingle()
  if (error || !saved) {
    console.error('[restaurant details] update failed:', error?.message)
    return { ok: false, status: 500, error: 'Erreur serveur / Server error' }
  }

  const changes = Object.fromEntries(fields.map(f => [f, { old: current[f] ?? null, new: check.patch[f] ?? null }]))
  await writeAudit({
    action: 'restaurant_details_changed', targetType: 'restaurant', targetId: current.id,
    performedBy: actor.id, performedByType: actor.type,
    previousData: Object.fromEntries(fields.map(f => [f, current[f] ?? null])),
    metadata: { changes },
  })
  if (check.cuisineProposed) {
    await recordProposal({ kind: 'cuisine', proposed: check.cuisineProposed, by: actor.type === 'owner' ? actor.id : null, targetType: 'restaurant', targetId: current.id, savedAs: String(check.patch.cuisine_type ?? '') })
  }
  const noticed = actor.type === 'owner' ? fields.filter(f => NOTICE_FIELDS.includes(f)) : []
  if (noticed.length) {
    const { error: nErr } = await supabaseAdmin.from('restaurant_change_notices').insert({
      restaurant_id: current.id, changed_by: actor.id,
      changes: Object.fromEntries(noticed.map(f => [f, changes[f]])),
    })
    if (nErr) console.error('[restaurant details] notice insert failed:', nErr.message)
  }
  return { ok: true, restaurant: saved, changed: fields }
}
