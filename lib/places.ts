import { refList, refFind, refKnown } from './refData'
import { picturesFirst, hasPicture } from './popularRanking'
// Lieux (I4) — fixed places with no date (monuments, museums, nature,
// markets…), in the Loisirs section. Client-safe shape and helpers. The
// places table is server-only: pages read it through /api/places, so the
// admin note and sources never leave the server.

export interface PlaceCategory { id: string; fr: string; en: string; icon: string }

// Place (À visiter) categories come from the reference data (Admin →
// Données de référence). places.category stores the code.
export function placeCategories(opts: { includeHidden?: boolean } = {}): PlaceCategory[] {
  return refList('place_category', opts).map(c => ({ id: c.code, fr: c.label_fr, en: c.label_en, icon: c.icon ?? '📍' }))
}

// The CSV's English categories → ours.
export const CSV_CATEGORY: Record<string, string> = {
  'Monument': 'monuments', 'Museum': 'museums', 'Nature & parks': 'nature', 'Viewpoint': 'nature',
  'Market': 'markets', 'Culture & arts': 'culture', 'Religious site': 'worship',
  'Craft & shopping': 'crafts', 'Leisure': 'leisure', 'Beach & day trip': 'daytrips',
}

export function placeCategory(id: string | null | undefined): PlaceCategory | null {
  const c = refFind('place_category', id)
  return c ? { id: c.code, fr: c.label_fr, en: c.label_en, icon: c.icon ?? '📍' } : null
}
export function placeCategoryLabel(id: string | null | undefined, locale: string): string {
  const c = placeCategory(id)
  return c ? (locale === 'en' ? c.en : c.fr) : ''
}

export interface PublicPlace {
  id: string; city: string; area: string | null; category: string
  title_fr: string; title_en: string | null; headline_fr: string | null; headline_en: string | null; description_fr: string | null; description_en: string | null
  tip_fr: string | null; tip_en: string | null; hours: string | null; price: string | null
  official_link: string | null; instagram_url: string | null; facebook_url: string | null; tiktok_url: string | null
  lat: number | null; lng: number | null; cover_url: string | null
  photo_credit: string | null; photo_credit_url: string | null
}
export const PUBLIC_PLACE_COLUMNS = 'id, city, area, category, title_fr, title_en, headline_fr, headline_en, description_fr, description_en, tip_fr, tip_en, hours, price, official_link, instagram_url, facebook_url, tiktok_url, lat, lng, cover_url, photo_credit, photo_credit_url'

// The viewer's language, French when the English text is missing.
export function pick(p: PublicPlace, field: 'title' | 'headline' | 'description' | 'tip', locale: string): string {
  const en = p[`${field}_en` as const], fr = p[`${field}_fr` as const]
  return (locale === 'en' ? en || fr : fr || en) ?? ''
}

export function directionsUrl(p: Pick<PublicPlace, 'lat' | 'lng' | 'title_fr' | 'area' | 'city'>): string {
  return p.lat != null && p.lng != null
    ? `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}`
    : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([p.title_fr, p.area, p.city, 'Cameroun'].filter(Boolean).join(', '))}`
}

export type PlaceInput = Partial<Record<keyof PublicPlace | 'status' | 'admin_note' | 'sources', unknown>>
export type PlaceValidation = { ok: true; place: Record<string, string | number | null> } | { ok: false; field: string; error: string }

const TEXT_LIMITS: Record<string, number> = {
  city: 60, area: 80, title_fr: 140, title_en: 140, headline_fr: 200, headline_en: 200, description_fr: 4000, description_en: 4000,
  tip_fr: 1000, tip_en: 1000, photo_credit: 300, hours: 300, price: 200, admin_note: 2000, sources: 4000,
}
const LINKS = ['official_link', 'instagram_url', 'facebook_url', 'tiktok_url', 'cover_url', 'photo_credit_url'] as const

// Validates the fields present (all required ones when `create`).
export function validatePlace(raw: PlaceInput, create: boolean): PlaceValidation {
  const out: Record<string, string | number | null> = {}
  for (const [k, max] of Object.entries(TEXT_LIMITS)) {
    if (!(k in raw)) continue
    const v = typeof raw[k as keyof PlaceInput] === 'string' ? (raw[k as keyof PlaceInput] as string).trim().slice(0, max) : ''
    out[k] = v || null
  }
  for (const k of LINKS) {
    if (!(k in raw)) continue
    const v = typeof raw[k] === 'string' ? (raw[k] as string).trim() : ''
    if (v && !/^https?:\/\/\S+$/.test(v)) return { ok: false, field: k, error: 'Lien invalide (https://…) / Invalid link (https://…)' }
    out[k] = v || null
  }
  if ('category' in raw) {
    if (!refKnown('place_category', String(raw.category))) return { ok: false, field: 'category', error: 'Catégorie invalide / Invalid category' }
    out.category = String(raw.category)
  }
  for (const k of ['lat', 'lng'] as const) {
    if (!(k in raw)) continue
    const n = raw[k] === null || raw[k] === '' ? null : Number(raw[k])
    if (n !== null && !Number.isFinite(n)) return { ok: false, field: k, error: 'Coordonnée invalide / Invalid coordinate' }
    out[k] = n
  }
  if ('status' in raw) {
    if (!['pending', 'active', 'hidden'].includes(String(raw.status))) return { ok: false, field: 'status', error: 'Statut invalide / Invalid status' }
    out.status = String(raw.status)
  }
  if (create) {
    if (!out.title_fr) return { ok: false, field: 'title_fr', error: 'Nom requis / Name required' }
    if (!out.city) return { ok: false, field: 'city', error: 'Ville requise / City required' }
    if (!out.category) return { ok: false, field: 'category', error: 'Catégorie requise / Category required' }
  }
  return { ok: true, place: out }
}

/** À visiter order: a real photo first, then the generated cover — A–Z (in
 *  the reader's language) inside each group. */
export function placesPicturesFirst<T extends PublicPlace>(places: T[], locale: string): T[] {
  const az = [...places].sort((a, b) => pick(a, 'title', locale).localeCompare(pick(b, 'title', locale), locale === 'en' ? 'en' : 'fr', { sensitivity: 'base' }))
  return picturesFirst(az, p => (hasPicture(p.cover_url) ? 0 : 1))
}
