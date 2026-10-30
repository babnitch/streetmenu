// The home rows (/api/popular): the most popular first, then filled up to
// `limit` with the rest in a fallback order — no duplicates. `popular` says
// whether anything was actually popular (the title depends on it).

//
// Home: pictures first. `tier` (0 = real photo, 1 = generated cover, 2 = no
// image) fills the free slots photo-first and orders the final list by tier;
// inside a tier the order is unchanged. Popular items always keep a slot.
export function rankWithFill<T extends { id: string }>(
  items: T[], score: (x: T) => number, fallback: (a: T, b: T) => number, limit: number,
  tier?: (x: T) => number,
): { list: T[]; popular: boolean } {
  const top = items.filter(x => score(x) > 0).sort((a, b) => score(b) - score(a)).slice(0, limit)
  const seen = new Set(top.map(x => x.id))
  const rest = items.filter(x => !seen.has(x.id)).sort(tier ? (a, b) => tier(a) - tier(b) || fallback(a, b) : fallback)
  const list = [...top, ...rest].slice(0, limit)
  return { list: tier ? picturesFirst(list, tier) : list, popular: top.length > 0 }
}

// Stable sort by picture tier (0 photo, 1 generated cover, 2 none); the
// current order is kept inside each tier.
export function picturesFirst<T>(items: T[], tier: (x: T) => number): T[] {
  return items.map((x, i) => ({ x, i, t: tier(x) })).sort((a, b) => a.t - b.t || a.i - b.i).map(v => v.x)
}

/** A real picture URL (uploaded, or Wikimedia for places). */
export const hasPicture = (url: string | null | undefined): boolean => typeof url === 'string' && /^https?:\/\//.test(url.trim())

// Events: the soonest first; one already running counts from today.
export function eventStartKey(e: { date?: string | null; time?: string | null }, today: string): string {
  const d = String(e.date ?? '')
  return `${d > today ? d : today} ${e.time ?? '99:99'}`
}
