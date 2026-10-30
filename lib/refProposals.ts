// Admin → Données de référence → Propositions: list the "Autre…" proposals
// and resolve them — accept (new value, set on the item), map (an existing
// value, set on the item) or reject (the item keeps what it was saved with).

import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { refFind, type RefKind } from '@/lib/refData'
import { cityCentre } from '@/lib/cities'

export interface ProposalRow {
  id: string; kind: RefKind; proposed: string; proposed_by: string | null; target_type: 'restaurant' | 'event' | 'place' | 'customer'
  target_id: string; saved_as: string | null; status: string; resolved_code: string | null; created_at: string; resolved_at: string | null
}

const TABLE = { restaurant: 'restaurants', event: 'events', place: 'places', customer: 'customers' } as const
const NAME = { restaurant: 'name', event: 'title', place: 'title_fr', customer: 'name' } as const

/** Who proposed it and on which item (name / title). */
export async function describe(rows: ProposalRow[]): Promise<Array<ProposalRow & { by: { name: string | null; phone: string | null } | null; target: string | null }>> {
  const byIds = Array.from(new Set(rows.map(r => r.proposed_by).filter(Boolean))) as string[]
  const { data: people } = byIds.length ? await supabaseAdmin.from('customers').select('id, name, phone').in('id', byIds) : { data: [] }
  const who = new Map((people ?? []).map(p => [p.id as string, { name: p.name as string | null, phone: p.phone as string | null }]))
  const names = new Map<string, string>()
  for (const t of Object.keys(TABLE) as Array<keyof typeof TABLE>) {
    const ids = rows.filter(r => r.target_type === t).map(r => r.target_id)
    if (!ids.length) continue
    const { data } = await supabaseAdmin.from(TABLE[t]).select(`id, ${NAME[t]}`).in('id', ids)
    for (const x of (data ?? []) as unknown as Array<Record<string, string>>) names.set(`${t}:${x.id}`, x[NAME[t]])
  }
  return rows.map(r => ({ ...r, by: r.proposed_by ? who.get(r.proposed_by) ?? null : null, target: names.get(`${r.target_type}:${r.target_id}`) ?? null }))
}

/** Set the value on the item the proposal came from. */
export async function applyToTarget(p: ProposalRow, code: string): Promise<string | null> {
  const v = refFind(p.kind, code)
  if (!v) return 'Valeur inconnue / Unknown value'
  const table = TABLE[p.target_type]
  let patch: Record<string, unknown>
  if (p.kind === 'city') {
    patch = { city: v.code }
    // A restaurant saved without a pin (proposed city) gets the city centre.
    if (p.target_type === 'restaurant') {
      const { data: r } = await supabaseAdmin.from('restaurants').select('lat, lng').eq('id', p.target_id).maybeSingle()
      const c = cityCentre(v.code)
      if (r && Number(r.lat) === 0 && Number(r.lng) === 0 && c) patch = { ...patch, lat: c.lat, lng: c.lng }
    }
  } else if (p.kind === 'cuisine') patch = { cuisine_type: v.label_fr }
  else patch = { category: v.code }
  if (p.kind !== 'city' && p.target_type === 'customer') return 'Cible invalide / Invalid target'
  const { error } = await supabaseAdmin.from(table).update(patch).eq('id', p.target_id)
  return error ? error.message : null
}
