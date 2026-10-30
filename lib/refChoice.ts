// Forms → reference data. A form sends either a listed value (code or, for
// older clients, its French label) or "Autre…" with a typed proposal.
//   - category / cuisine "Autre…": saved with the closest listed value
//     (keyword or label match), else "Autre"; the text becomes a proposal.
//   - city "Autre…": saved with the typed name — no public list shows it
//     until an admin accepts or maps the proposal (the caller keeps the item
//     non-public); never a new city page by itself.
// The proposal itself is recorded with recordProposal (Admin → Données de
// référence → Propositions). Server only (recordProposal).

import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { refFind, refList, type RefKind } from '@/lib/refData'
import { matchesCuisineCategory, normalizeCuisine } from '@/lib/cuisineCategories'
import { isTestCity } from '@/lib/cities'

const clean = (v: unknown, max = 60): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '')
const sameText = (a: string, b: string) => normalizeCuisine(a) === normalizeCuisine(b)

/** A visible value matching a code or a label (FR or EN). */
function offeredValue(kind: RefKind, raw: string) {
  return refList(kind).find(v => v.code === raw || sameText(v.code, raw) || sameText(v.label_fr, raw) || sameText(v.label_en, raw))
}

export type CityChoice = { ok: true; city: string; proposed: string | null } | { ok: false; error: string }
export function chooseCity(raw: unknown, other: unknown): CityChoice {
  const typed = clean(other)
  if (typed) {
    if (typed.length < 2) return { ok: false, error: 'Nom de ville trop court / City name too short' }
    const known = offeredValue('city', typed)
    if (known) return { ok: true, city: known.code, proposed: null }
    const name = typed.split(' ').map(w => w ? w[0].toUpperCase() + w.slice(1) : w).join(' ')
    return { ok: true, city: name, proposed: typed }
  }
  const r = clean(raw)
  // The tests' made-up city, on the test server only (see lib/cities.ts).
  if (process.env.TEST_ONLY_PHONE_PREFIX && isTestCity(r)) return { ok: true, city: r, proposed: null }
  const v = offeredValue('city', r)
  return v ? { ok: true, city: v.code, proposed: null } : { ok: false, error: 'Ville invalide / Invalid city' }
}

export type CuisineChoice = { ok: true; cuisine: string | null; proposed: string | null } | { ok: false; error: string }
/** Optional: empty → null (no cuisine). Saved as the value's French label. */
export function chooseCuisine(raw: unknown, other: unknown): CuisineChoice {
  const typed = clean(other)
  if (typed) {
    const exact = offeredValue('cuisine', typed)
    if (exact) return { ok: true, cuisine: exact.label_fr, proposed: null }
    const closest = refList('cuisine').find(v => v.code !== 'autre' && matchesCuisineCategory({ cuisine_type: typed }, v.code))
    return { ok: true, cuisine: (closest ?? refFind('cuisine', 'autre'))?.label_fr ?? 'Autre', proposed: typed }
  }
  const r = clean(raw)
  if (!r) return { ok: true, cuisine: null, proposed: null }
  const v = offeredValue('cuisine', r)
  return v ? { ok: true, cuisine: v.label_fr, proposed: null } : { ok: false, error: 'Type de cuisine invalide / Invalid cuisine' }
}

export type CategoryChoice = { ok: true; category: string; proposed: string | null } | { ok: false; error: string }
/** Event or place category: the code. "Autre…" → closest label, else Autre. */
export function chooseCategory(kind: 'event_category' | 'place_category', raw: unknown, other: unknown): CategoryChoice {
  const typed = clean(other)
  const autre = refList(kind, { includeHidden: true }).find(v => sameText(v.code, 'autre'))?.code ?? (kind === 'event_category' ? 'Autre' : 'autre')
  if (typed) {
    const exact = offeredValue(kind, typed)
    if (exact) return { ok: true, category: exact.code, proposed: null }
    const n = normalizeCuisine(typed)
    const closest = refList(kind).find(v => v.code !== autre && (normalizeCuisine(v.label_fr).includes(n) || n.includes(normalizeCuisine(v.label_fr))))
    return { ok: true, category: closest?.code ?? autre, proposed: typed }
  }
  const v = offeredValue(kind, clean(raw))
  return v ? { ok: true, category: v.code, proposed: null } : { ok: false, error: 'Catégorie invalide / Invalid category' }
}

export type ProposalTarget = 'restaurant' | 'event' | 'place' | 'customer'
export async function recordProposal(p: { kind: RefKind; proposed: string; by: string | null; targetType: ProposalTarget; targetId: string; savedAs: string | null }): Promise<void> {
  const { error } = await supabaseAdmin.from('ref_proposals').insert({
    kind: p.kind, proposed: p.proposed.slice(0, 60), proposed_by: p.by, target_type: p.targetType, target_id: p.targetId, saved_as: p.savedAs,
  })
  if (error) console.error('[ref] proposal not recorded:', error.message)
}
