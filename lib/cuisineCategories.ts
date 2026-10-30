// Cuisines — from the reference data (lib/refData.ts: Admin → Données de
// référence).
//
// Restaurants store a free-text `cuisine_type` (optional — empty means no
// cuisine is shown). Forms save a value's French label; older rows hold
// any wording ("Braisé / Grillades", "Cuisine camerounaise"…). Rather than
// migrate that column we match it against each value's keywords (accent-
// and case-insensitive), for the filter chips. `description` is checked
// too, because pre-vendor-signup rows put the cuisine there.
//
// Icons are for the filter chips ONLY; cards and pages show the cuisine as
// plain text (cuisineText), never on a photo or a generated cover.

import { refList, refFind } from './refData'

export interface CuisineCategory {
  id:   string
  icon: string
  fr:   string
  en:   string
  /** Accent-stripped, lowercase substrings. A hit on any one matches. */
  keywords: string[]
}

export function cuisineCategories(opts: { includeHidden?: boolean } = {}): CuisineCategory[] {
  return refList('cuisine', opts).map(c => ({ id: c.code, icon: c.icon ?? '🍽️', fr: c.label_fr, en: c.label_en, keywords: c.keywords }))
}

// The chip row on the Restaurants page, in this order (when visible).
// Camerounaise, Sénégalaise, Ivoirienne… stay values in forms and search.
export const HOME_CUISINE_CHIPS = ['grillades', 'poisson', 'fastfood', 'pizza', 'healthy', 'bar', 'desserts'] as const
export function homeCuisineChips(): CuisineCategory[] {
  const all = cuisineCategories()
  return HOME_CUISINE_CHIPS.map(id => all.find(c => c.id === id)).filter((c): c is CuisineCategory => !!c)
}

// Lowercase + strip diacritics so "Braisé" ≡ "braise". Falls back to a
// plain lowercase when the runtime lacks Unicode normalisation.
export function normalizeCuisine(value?: string | null): string {
  if (!value) return ''
  const lower = value.toLowerCase()
  try {
    return lower.normalize('NFD').replace(/[̀-ͯ]/g, '')
  } catch {
    return lower
  }
}

// Does this restaurant belong to the given cuisine? Its keywords (or, for a
// value without keywords, its label) found in cuisine_type / description.
export function matchesCuisineCategory(
  source: { cuisine_type?: string | null; description?: string | null; name?: string | null },
  categoryId: string,
): boolean {
  const cat = refFind('cuisine', categoryId)
  if (!cat) return false
  const haystack = normalizeCuisine([source.cuisine_type, source.description].filter(Boolean).join(' '))
  if (!haystack) return false
  const keys = cat.keywords.length ? cat.keywords : [normalizeCuisine(cat.label_fr)]
  return keys.some(k => k && haystack.includes(normalizeCuisine(k)))
}

// The cuisine as small grey text: a reference value in the viewer's
// language (when cuisine_type IS one — code or label), else the text as
// typed; null when the restaurant has none (no fallback, no default).
export function cuisineText(source: { cuisine_type?: string | null }, locale: string): string | null {
  const raw = (source.cuisine_type ?? '').trim()
  if (!raw) return null
  const n = normalizeCuisine(raw)
  const hit = refList('cuisine', { includeHidden: true })
    .find(c => c.code === n || normalizeCuisine(c.label_fr) === n || normalizeCuisine(c.label_en) === n)
  return hit ? (locale === 'en' ? hit.label_en : hit.label_fr) : raw
}
