// In-place list search (N1): the Loisirs events list and the restaurant list.
// Case- and accent-insensitive ("epice" finds "Épicé"), every word of the
// query must appear in one of the fields.

export function foldText(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

export function matchesSearch(query: string, fields: Array<string | null | undefined>): boolean {
  const words = foldText(query).split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  const hay = foldText(fields.filter(Boolean).join(' \u0001 '))
  return words.every(w => hay.includes(w))
}
