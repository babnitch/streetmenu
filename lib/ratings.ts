// Rating tag dictionary + aggregate computation helpers.
//
// Tags are referenced by short ids (e.g. 'good_food') so the UI label can
// be re-translated without re-storing data. Two sets:
//   POSITIVE_TAGS — shown when rating ≥ 4
//   NEGATIVE_TAGS — shown when rating ≤ 3
// The boundary at 3 is the spec's; either set may be used at exactly 3 in
// the UI by showing both, but the canonical store is the tag id list.

export interface RatingTag {
  id:    string
  emoji: string
  fr:    string
  en:    string
}

export const POSITIVE_TAGS: RatingTag[] = [
  { id: 'good_food',         emoji: '🍽️', fr: 'Bonne nourriture',         en: 'Good food' },
  { id: 'fast_service',      emoji: '⚡', fr: 'Service rapide',            en: 'Fast service' },
  { id: 'correct_order',     emoji: '✅', fr: 'Commande correcte',         en: 'Correct order' },
  { id: 'good_value',        emoji: '💰', fr: 'Bon rapport qualité-prix',  en: 'Good value' },
  { id: 'good_presentation', emoji: '📦', fr: 'Bonne présentation',        en: 'Good presentation' },
  { id: 'friendly_staff',    emoji: '😊', fr: 'Personnel aimable',         en: 'Friendly staff' },
]

export const NEGATIVE_TAGS: RatingTag[] = [
  { id: 'too_slow',         emoji: '🐌', fr: 'Trop lent',          en: 'Too slow' },
  { id: 'wrong_order',      emoji: '❌', fr: 'Commande incorrecte', en: 'Wrong order' },
  { id: 'too_expensive',    emoji: '💸', fr: 'Trop cher',           en: 'Too expensive' },
  { id: 'poor_quality',     emoji: '😞', fr: 'Mauvaise qualité',    en: 'Poor quality' },
  { id: 'poor_presentation',emoji: '📦', fr: 'Mauvaise présentation', en: 'Poor presentation' },
]

export const ALL_TAGS: Record<string, RatingTag> = {}
for (const t of POSITIVE_TAGS) ALL_TAGS[t.id] = t
for (const t of NEGATIVE_TAGS) ALL_TAGS[t.id] = t

// Returns the right tag set for a given rating. Used by the rating modal.
export function tagsForRating(rating: number): RatingTag[] {
  if (rating >= 4) return POSITIVE_TAGS
  return NEGATIVE_TAGS
}

// Validates an incoming tag id list against the dictionary. Unknown tags
// are dropped (caller treats this as "the client sent a stale tag" rather
// than rejecting the whole submission).
export function sanitizeTags(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  const out: string[] = []
  for (const t of input) {
    if (typeof t === 'string' && ALL_TAGS[t]) out.push(t)
  }
  return Array.from(new Set(out))
}

export interface RatingAggregate {
  average:        number             // 0 when count = 0
  count:          number
  distribution:   Record<1 | 2 | 3 | 4 | 5, number>
  top_tags:       Array<{ id: string; count: number }>
}

// Aggregates a list of rating rows into the shape the UI renders.
// Stable ordering for top_tags: count desc, id asc.
export function aggregate(rows: Array<{ rating: number; tags: string[] | null }>): RatingAggregate {
  const distribution: Record<1 | 2 | 3 | 4 | 5, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
  let total = 0
  const tagCounts: Record<string, number> = {}
  for (const r of rows) {
    const rating = Math.round(r.rating) as 1 | 2 | 3 | 4 | 5
    if (rating >= 1 && rating <= 5) {
      distribution[rating] += 1
      total += rating
    }
    if (Array.isArray(r.tags)) {
      for (const t of r.tags) tagCounts[t] = (tagCounts[t] ?? 0) + 1
    }
  }
  const count = rows.length
  const average = count > 0 ? Math.round((total / count) * 10) / 10 : 0
  const top_tags = Object.entries(tagCounts)
    .sort(([aId, aN], [bId, bN]) => bN - aN || aId.localeCompare(bId))
    .slice(0, 5)
    .map(([id, count]) => ({ id, count }))
  return { average, count, distribution, top_tags }
}
