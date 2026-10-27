// Event capacity is PER DAY (supabase-event-day-capacity.sql). Pure helpers
// shared by the forms (client) and the API (server). 0 = unlimited.

// With tiers, the event's capacity is the sum of the tiers' max per day. A
// tier without a max makes the whole event unlimited.
export function capacityFromTiers(maxPerDay: number[]): number {
  if (maxPerDay.length === 0) return 0
  if (maxPerDay.some(m => !(m > 0))) return 0
  return maxPerDay.reduce((s, m) => s + m, 0)
}

// "3 jours × 3 places = 9 places au total" under a multi-day capacity field.
// Null for a single day or unlimited capacity (nothing to multiply).
export function capacityTotalLine(days: number, perDay: number, lang: 'fr' | 'en'): string | null {
  if (days < 2 || !(perDay > 0)) return null
  const total = days * perDay
  return lang === 'en'
    ? `${days} days × ${perDay} ${perDay === 1 ? 'seat' : 'seats'} = ${total} seats in total`
    : `${days} jours × ${perDay} ${perDay === 1 ? 'place' : 'places'} = ${total} places au total`
}
