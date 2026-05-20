// Display labels for the 9 canonical event categories.
//
// The database always stores the French (canonical) value — Concert,
// Gastronomie, Enfants, etc. The UI translates the label at render time
// via categoryLabel(value, locale). Only the labels differ; the stored
// value is the same in both languages.
//
// The 👶 emoji on Enfants/Kids is preserved here so callers don't each
// have to remember to add it.

import type { Locale } from './translations'

const FR_LABEL: Record<string, string> = {
  Concert:      'Concert',
  Festival:     'Festival',
  'BT/Club':    'BT/Club',
  Sport:        'Sport',
  Culture:      'Culture',
  Gastronomie:  'Gastronomie',
  Enfants:      '👶 Enfants',
  Business:     'Business',
  Autre:        'Autre',
}

const EN_LABEL: Record<string, string> = {
  Concert:      'Concert',
  Festival:     'Festival',
  'BT/Club':    'BT/Club',
  Sport:        'Sports',
  Culture:      'Culture',
  Gastronomie:  'Food & Drink',
  Enfants:      '👶 Kids',
  Business:     'Business',
  Autre:        'Other',
}

// Render-only translation. Returns the input unchanged if the value
// isn't one of the canonical 9 (e.g. legacy rows that haven't been
// migrated yet) so the UI never blanks out on data drift.
export function categoryLabel(cat: string, locale: Locale): string {
  const map = locale === 'en' ? EN_LABEL : FR_LABEL
  return map[cat] ?? cat
}

// Bilingual "FR / EN" form for WhatsApp messages, where we can't pick
// one language from the recipient's perspective.
export function categoryLabelBilingual(cat: string): string {
  const fr = FR_LABEL[cat] ?? cat
  const en = EN_LABEL[cat] ?? cat
  return fr === en ? fr : `${fr} / ${en}`
}
