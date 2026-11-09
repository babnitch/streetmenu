// "Is this found event one we already have?" — title + city + dates.
// Accents, case and punctuation never matter. Two titles are the same event
// when (almost) every word of the shorter one is in the longer one:
// "The Divine Tour by Phido" = "THE DIVINE TOUR BY PHIDO – Yaoundé".

const STOP = new Set([
  'le', 'la', 'les', 'de', 'du', 'des', 'un', 'une', 'et', 'en', 'au', 'aux', 'a', 'l', 'd',
  'the', 'of', 'and', 'by', 'at', 'in', 'on', 'for', 'with', 'par', 'avec', 'pour', 'sur',
])

export const DUPLICATE_SCORE = 0.8
export const POSSIBLE_SCORE = 0.5

/** Folded title: no accents, lower case, words separated by one space. */
export function titleKey(title: string): string {
  return title.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim()
}

function words(title: string): Set<string> {
  return new Set(titleKey(title).split(' ').filter(w => w.length >= 2 && !STOP.has(w)))
}

/** 0 … 1. One-word titles must match exactly (one word proves nothing). */
export function titleSimilarity(a: string, b: string): number {
  if (titleKey(a) === titleKey(b)) return 1
  const A = words(a), B = words(b)
  if (!A.size || !B.size) return 0
  let common = 0
  A.forEach(w => { if (B.has(w)) common++ })
  const small = Math.min(A.size, B.size)
  if (small < 2) return A.size === B.size && common === A.size ? 1 : 0
  return common / small
}

export type DuplicateVerdict =
  | { kind: 'duplicate'; id: string }
  | { kind: 'possible'; id: string }
  | { kind: 'new' }

/** `others` are already the same city with overlapping dates. */
export function classifyAgainst(title: string, others: Array<{ id: string; title: string }>): DuplicateVerdict {
  let best: { id: string; score: number } | null = null
  for (const o of others) {
    const score = titleSimilarity(title, o.title)
    if (!best || score > best.score) best = { id: o.id, score }
  }
  if (best && best.score >= DUPLICATE_SCORE) return { kind: 'duplicate', id: best.id }
  if (best && best.score >= POSSIBLE_SCORE) return { kind: 'possible', id: best.id }
  return { kind: 'new' }
}
