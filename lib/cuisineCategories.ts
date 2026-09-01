// Cuisine categories for the mobile home page's horizontal icon row.
//
// Restaurants store a free-text `cuisine_type`: the /join dropdown, the
// WhatsApp onboarding flow and the admin editor each seed slightly
// different wording — "Braisé / Grillades", "Grillades", "Cuisine
// camerounaise", "Camerounaise", "Fruits de mer"… Rather than migrate
// that column (and break every existing row) we match it at render time
// against a keyword list per category. `description` is checked too,
// because pre-vendor-signup rows put the cuisine there.
//
// Matching is accent- and case-insensitive so "Braisé" and "braise"
// both land on Grillades.

export interface CuisineCategory {
  id:   string
  icon: string
  fr:   string
  en:   string
  /** Accent-stripped, lowercase substrings. A hit on any one matches. */
  keywords: string[]
}

export const CUISINE_CATEGORIES: CuisineCategory[] = [
  {
    id: 'grillades', icon: '🍖', fr: 'Grillades', en: 'Grilled',
    keywords: ['grillade', 'grill', 'braise', 'brochette', 'bbq', 'barbecue', 'poulet dg', 'soya', 'rotisserie'],
  },
  {
    id: 'camerounaise', icon: '🍛', fr: 'Camerounaise', en: 'Cameroonian',
    keywords: ['camerounaise', 'cameroun', 'africain', 'african', 'traditionnel', 'ndole', 'eru',
               'ivoirienne', 'senegalaise', 'togolaise', 'terroir'],
  },
  {
    id: 'fastfood', icon: '🍝', fr: 'Fast-food', en: 'Fast food',
    keywords: ['fast food', 'fastfood', 'fast-food', 'burger', 'sandwich', 'snack', 'shawarma', 'tacos', 'frites'],
  },
  {
    id: 'healthy', icon: '🥗', fr: 'Healthy', en: 'Healthy',
    keywords: ['healthy', 'vegetarien', 'vegetarian', 'vegan', 'salade', 'salad', 'bio', 'jus', 'smoothie', 'poke'],
  },
  {
    id: 'pizza', icon: '🍕', fr: 'Pizza', en: 'Pizza',
    keywords: ['pizza', 'pizzeria', 'italien', 'italian', 'pasta', 'pates'],
  },
  {
    id: 'poisson', icon: '🐟', fr: 'Poisson', en: 'Fish',
    keywords: ['poisson', 'fish', 'fruits de mer', 'seafood', 'maquereau', 'bar braise', 'crevette', 'gambas'],
  },
  {
    id: 'bar', icon: '🍺', fr: 'Bar', en: 'Drinks',
    keywords: ['bar', 'drink', 'boisson', 'lounge', 'club', 'cocktail', 'biere', 'beer', 'pub', 'cave'],
  },
  {
    id: 'desserts', icon: '🍰', fr: 'Desserts', en: 'Desserts',
    keywords: ['dessert', 'patisserie', 'pastry', 'glace', 'ice cream', 'gateau', 'cake', 'boulangerie', 'bakery', 'crepe'],
  },
]

// Lowercase + strip diacritics so "Braisé" ≡ "braise". Falls back to a
// plain lowercase when the runtime lacks Unicode normalisation.
export function normalizeCuisine(value?: string | null): string {
  if (!value) return ''
  const lower = value.toLowerCase()
  try {
    return lower.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  } catch {
    return lower
  }
}

// Does this restaurant belong to the given category? Checks cuisine_type
// first and falls back to description for legacy rows that never got a
// cuisine_type. Unknown category ids match nothing.
export function matchesCuisineCategory(
  source: { cuisine_type?: string | null; description?: string | null; name?: string | null },
  categoryId: string,
): boolean {
  const cat = CUISINE_CATEGORIES.find(c => c.id === categoryId)
  if (!cat) return false
  const haystack = normalizeCuisine(
    [source.cuisine_type, source.description].filter(Boolean).join(' '),
  )
  if (!haystack) return false
  return cat.keywords.some(k => haystack.includes(k))
}

export function cuisineCategoryLabel(cat: CuisineCategory, locale: string): string {
  return locale === 'en' ? cat.en : cat.fr
}
