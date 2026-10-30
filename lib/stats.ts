// Anonymous daily counts (stats_daily, supabase-stats.sql). Shared by the
// /api/track route (writes) and the overview / Statistiques APIs (reads).
// What is stored: day, city, item, metric, a number. Never a cookie, an IP
// or a user id; searches keep their words (normalised), not who searched.

export const STAT_METRICS = ['visit', 'view', 'click_whatsapp', 'click_call', 'click_tickets', 'click_directions', 'click_map', 'search'] as const
export type StatMetric = (typeof STAT_METRICS)[number]
export const STAT_ITEM_TYPES = ['', 'restaurant', 'event', 'place', 'search'] as const
export type StatItemType = (typeof STAT_ITEM_TYPES)[number]
export const CLICK_METRICS: readonly StatMetric[] = ['click_whatsapp', 'click_call', 'click_tickets', 'click_directions', 'click_map']

// Obvious bots and link-preview fetchers (they rarely run JS, but some do).
const BOT_UA = /bot|crawl|spider|slurp|bingpreview|headless|lighthouse|pagespeed|preview|facebookexternalhit|whatsapp|telegram|curl|wget|python|httpclient|axios|node-fetch|go-http/i
export function isBot(userAgent: string | null | undefined): boolean {
  return !userAgent || userAgent.length < 20 || BOT_UA.test(userAgent)
}

// Search words: lower case, spaces collapsed, 60 chars max. A query that
// looks like a phone number (6+ digits) is not kept.
export function normaliseSearch(q: unknown): string | null {
  if (typeof q !== 'string') return null
  const s = q.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 60)
  if (s.length < 2 || (s.match(/\d/g) ?? []).length >= 6) return null
  return s
}

export interface TrackInput { metric: StatMetric; type: StatItemType; id: string; city: string }

// Checks a beacon body; null = ignore it.
export function parseTrack(raw: unknown, cities: readonly string[]): TrackInput | null {
  const b = (raw ?? {}) as Record<string, unknown>
  const metric = String(b.m ?? '') as StatMetric
  if (!(STAT_METRICS as readonly string[]).includes(metric)) return null
  const city = typeof b.c === 'string' && cities.includes(b.c) ? b.c : ''
  if (metric === 'visit') return { metric, type: '', id: '', city }
  if (metric === 'search') {
    const words = normaliseSearch(b.q)
    return words ? { metric, type: 'search', id: words, city } : null
  }
  const type = String(b.t ?? '') as StatItemType
  const id = String(b.i ?? '')
  if (!['restaurant', 'event', 'place'].includes(type) || !/^[0-9a-f-]{36}$/i.test(id)) return null
  return { metric, type, id, city }
}
