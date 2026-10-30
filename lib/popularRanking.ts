// The home rows (/api/popular): the most popular first, then filled up to
// `limit` with the rest in a fallback order — no duplicates. `popular` says
// whether anything was actually popular (the title depends on it).

export function rankWithFill<T extends { id: string }>(
  items: T[], score: (x: T) => number, fallback: (a: T, b: T) => number, limit: number,
): { list: T[]; popular: boolean } {
  const top = items.filter(x => score(x) > 0).sort((a, b) => score(b) - score(a)).slice(0, limit)
  const seen = new Set(top.map(x => x.id))
  const rest = items.filter(x => !seen.has(x.id)).sort(fallback)
  return { list: [...top, ...rest].slice(0, limit), popular: top.length > 0 }
}

// Events: the soonest first; one already running counts from today.
export function eventStartKey(e: { date?: string | null; time?: string | null }, today: string): string {
  const d = String(e.date ?? '')
  return `${d > today ? d : today} ${e.time ?? '99:99'}`
}
