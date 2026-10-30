// Event categories: labels, icons and the offered list.
//
// The database always stores the canonical code — Concert, Gastronomie,
// Enfants, etc. The UI translates the label at render time via
// categoryLabel(value, locale).

import type { Locale } from './translations'
import { refList, refFind, refKnown, refLabel } from './refData'

// Event categories come from the reference data (Admin → Données de
// référence). events.category stores the code ('Concert', 'Enfants'…).

/** Offered categories (forms, filters, subscriptions), in display order. */
export const eventCategories = (opts: { includeHidden?: boolean } = {}): string[] =>
  refList('event_category', opts).map(c => c.code)
/** Known category (visible or hidden). */
export const isEventCategory = (v: unknown): boolean => refKnown('event_category', v)
/** The category's icon (posters, compact rows). */
export const eventCategoryIcon = (code: string | null | undefined): string => refFind('event_category', code)?.icon ?? '🎉'

// Render-only translation (hidden values too). Returns the input unchanged
// for an unknown value so the UI never blanks out on data drift.
export function categoryLabel(cat: string, locale: Locale): string {
  return refLabel('event_category', cat, locale)
}

// Bilingual "FR / EN" form for WhatsApp messages, where we can't pick
// one language from the recipient's perspective.
export function categoryLabelBilingual(cat: string): string {
  const v = refFind('event_category', cat)
  const fr = v?.label_fr ?? cat
  const en = v?.label_en ?? cat
  return fr === en ? fr : `${fr} / ${en}`
}
