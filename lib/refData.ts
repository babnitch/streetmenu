// Reference data — cities, cuisines, event categories, place (À visiter)
// categories. The lists live in the database (ref_values, managed in Admin →
// Données de référence). This module holds the CURRENT lists for both the
// server and the browser:
//   - it starts from REF_BACKUP (the values as seeded, hidden ones included),
//     so the site never breaks when the database can't be read;
//   - the server refreshes it from the database (lib/refDataServer.ts, 60 s
//     cache); the browser from /api/ref (lib/useRefData.tsx).
// Pickers, forms and filters use VISIBLE values; labels on items that
// already use a hidden value still show (refLabel finds hidden values too).
// Pure data, no React and no server imports.

export type RefKind = 'city' | 'cuisine' | 'event_category' | 'place_category'
export const REF_KINDS: readonly RefKind[] = ['city', 'cuisine', 'event_category', 'place_category']

export interface RefValue {
  kind: RefKind
  code: string
  label_fr: string
  label_en: string
  icon: string | null
  keywords: string[]
  country?: string | null
  lat?: number | null
  lng?: number | null
  zoom?: number | null
  visible: boolean
  sort_order: number
}

const v = (kind: RefKind, code: string, label_fr: string, label_en: string, sort_order: number, extra: Partial<RefValue> = {}): RefValue =>
  ({ kind, code, label_fr, label_en, icon: null, keywords: [], visible: true, sort_order, ...extra })

// The backup copy = what supabase-reference-data.sql seeded (as run on
// 2026-10-30). Keep it in step with the seed, not with admin edits.
export const REF_BACKUP: readonly RefValue[] = [
  v('city', 'Yaoundé', 'Yaoundé', 'Yaoundé', 10, { country: 'CM', lat: 3.848, lng: 11.5021, zoom: 13 }),
  v('city', 'Douala', 'Douala', 'Douala', 20, { country: 'CM', lat: 4.0511, lng: 9.7679, zoom: 13 }),
  v('city', 'Abidjan', 'Abidjan', 'Abidjan', 30, { country: 'CI', lat: 5.36, lng: -4.0083, zoom: 13, visible: false }),
  v('city', 'Dakar', 'Dakar', 'Dakar', 40, { country: 'SN', lat: 14.6937, lng: -17.4441, zoom: 13, visible: false }),
  v('city', 'Lomé', 'Lomé', 'Lomé', 50, { country: 'TG', lat: 6.1375, lng: 1.2123, zoom: 13, visible: false }),

  v('cuisine', 'grillades', 'Grillades', 'Grilled', 10, { icon: '🍖', keywords: ['grillade', 'grill', 'braise', 'brochette', 'bbq', 'barbecue', 'poulet dg', 'soya', 'rotisserie'] }),
  v('cuisine', 'camerounaise', 'Camerounaise', 'Cameroonian', 20, { icon: '🍛', keywords: ['camerounaise', 'cameroun', 'africain', 'african', 'traditionnel', 'ndole', 'eru', 'terroir'] }),
  v('cuisine', 'senegalaise', 'Sénégalaise', 'Senegalese', 25, { icon: '🍽️', keywords: ['senegalaise', 'senegal', 'thieb', 'thieboudienne', 'yassa', 'mafe', 'dibi'] }),
  v('cuisine', 'ivoirienne', 'Ivoirienne', 'Ivorian', 26, { icon: '🍽️', keywords: ['ivoirienne', 'ivoirien', 'attieke', 'garba', 'alloco', 'kedjenou', 'placali'] }),
  v('cuisine', 'fastfood', 'Fast-food', 'Fast food', 30, { icon: '🍝', keywords: ['fast food', 'fastfood', 'fast-food', 'burger', 'sandwich', 'snack', 'shawarma', 'tacos', 'frites'] }),
  v('cuisine', 'healthy', 'Healthy', 'Healthy', 40, { icon: '🥗', keywords: ['healthy', 'vegetarien', 'vegetarian', 'vegan', 'salade', 'salad', 'bio', 'jus', 'smoothie', 'poke'] }),
  v('cuisine', 'pizza', 'Pizza', 'Pizza', 50, { icon: '🍕', keywords: ['pizza', 'pizzeria', 'italien', 'italian', 'pasta', 'pates'] }),
  v('cuisine', 'poisson', 'Poisson', 'Fish', 60, { icon: '🐟', keywords: ['poisson', 'fish', 'fruits de mer', 'seafood', 'maquereau', 'bar braise', 'crevette', 'gambas'] }),
  v('cuisine', 'bar', 'Bar', 'Drinks', 70, { icon: '🍺', keywords: ['bar', 'drink', 'boisson', 'lounge', 'club', 'cocktail', 'biere', 'beer', 'pub', 'cave'] }),
  v('cuisine', 'desserts', 'Desserts', 'Desserts', 80, { icon: '🍰', keywords: ['dessert', 'patisserie', 'pastry', 'glace', 'ice cream', 'gateau', 'cake', 'boulangerie', 'bakery', 'crepe'] }),
  v('cuisine', 'autre', 'Autre', 'Other', 999, { icon: '🍽️' }),

  v('event_category', 'Concert', 'Concert', 'Concert', 10, { icon: '🎵' }),
  v('event_category', 'Festival', 'Festival', 'Festival', 20, { icon: '🎪' }),
  v('event_category', 'BT/Club', 'BT/Club', 'BT/Club', 30, { icon: '🪩' }),
  v('event_category', 'Sport', 'Sport', 'Sports', 40, { icon: '⚽' }),
  v('event_category', 'Culture', 'Culture', 'Culture', 50, { icon: '🎭' }),
  v('event_category', 'Gastronomie', 'Gastronomie', 'Food & Drink', 60, { icon: '🍲' }),
  v('event_category', 'Enfants', 'Enfants', 'Kids', 70, { icon: '👶' }),
  v('event_category', 'Business', 'Business', 'Business', 80, { icon: '💼' }),
  v('event_category', 'Autre', 'Autre', 'Other', 999, { icon: '🎉' }),

  v('place_category', 'monuments', 'Monuments', 'Monuments', 10, { icon: '🏛️' }),
  v('place_category', 'museums', 'Musées', 'Museums', 20, { icon: '🖼️' }),
  v('place_category', 'nature', 'Nature & points de vue', 'Nature & viewpoints', 30, { icon: '🌳' }),
  v('place_category', 'markets', 'Marchés', 'Markets', 40, { icon: '🧺' }),
  v('place_category', 'culture', 'Culture & arts', 'Culture & arts', 50, { icon: '🎭' }),
  v('place_category', 'worship', 'Lieux de culte', 'Places of worship', 60, { icon: '⛪' }),
  v('place_category', 'crafts', 'Artisanat & shopping', 'Crafts & shopping', 70, { icon: '🛍️' }),
  v('place_category', 'leisure', 'Loisirs & sport', 'Leisure & sport', 80, { icon: '⚽' }),
  v('place_category', 'daytrips', 'Excursions', 'Day trips', 90, { icon: '🏖️' }),
  v('place_category', 'autre', 'Autre', 'Other', 999, { icon: '📍' }),
]

let current: readonly RefValue[] = REF_BACKUP
let version = 0

/** Replace the current lists (server refresh, /api/ref). Ignores an empty or
 *  partial answer: a kind with no value keeps its backup. */
export function setRefValues(values: readonly RefValue[]): void {
  if (!Array.isArray(values) || values.length === 0) return
  const kinds = new Set(values.map(x => x.kind))
  current = [...values, ...REF_BACKUP.filter(b => !kinds.has(b.kind))]
  version++
}
export const refVersion = (): number => version
export const allRefValues = (): readonly RefValue[] => current

/** The values of a kind, in display order. Visible only unless asked. */
export function refList(kind: RefKind, opts: { includeHidden?: boolean } = {}): RefValue[] {
  return current.filter(x => x.kind === kind && (opts.includeHidden || x.visible))
    .slice().sort((a, b) => a.sort_order - b.sort_order || a.label_fr.localeCompare(b.label_fr))
}

/** A value by code (case-insensitive), hidden ones included. */
export function refFind(kind: RefKind, code: string | null | undefined): RefValue | undefined {
  if (!code) return undefined
  const c = code.trim().toLowerCase()
  return current.find(x => x.kind === kind && x.code.toLowerCase() === c)
}

/** The label in the viewer's language; the code itself when unknown. */
export function refLabel(kind: RefKind, code: string | null | undefined, locale: string): string {
  const x = refFind(kind, code)
  if (!x) return code ?? ''
  return locale === 'en' ? x.label_en : x.label_fr
}

/** Known value (visible or hidden) — existing rows stay valid. */
export const refKnown = (kind: RefKind, code: unknown): boolean => typeof code === 'string' && !!refFind(kind, code)
/** Offered value (visible) — what a form may submit. */
export const refOffered = (kind: RefKind, code: unknown): boolean => typeof code === 'string' && !!refFind(kind, code)?.visible
