'use client'

// Anonymous counting from the browser (see lib/stats.ts, /api/track).
// Fire-and-forget with sendBeacon; never blocks a tap. A "visit" is counted
// once per browser per day: the only thing kept is the day of the last
// count, in this browser's storage — nothing is sent that identifies it.

type Metric = 'visit' | 'view' | 'click_whatsapp' | 'click_call' | 'click_tickets' | 'click_directions' | 'click_map' | 'search'
type ItemType = 'restaurant' | 'event' | 'place'

function send(body: Record<string, string | undefined>): void {
  const data = JSON.stringify(body)
  try {
    if (typeof navigator !== 'undefined' && navigator.sendBeacon && navigator.sendBeacon('/api/track', new Blob([data], { type: 'text/plain' }))) return
  } catch { /* fall back */ }
  try { void fetch('/api/track', { method: 'POST', body: data, keepalive: true }).catch(() => null) } catch { /* ignore */ }
}

export function track(metric: Exclude<Metric, 'visit' | 'search'>, type: ItemType, id: string, city?: string | null): void {
  send({ m: metric, t: type, i: id, c: city ?? undefined })
}

export function trackSearch(words: string, city?: string | null): void {
  if (words.trim().length >= 2) send({ m: 'search', q: words, c: city ?? undefined })
}

export function trackVisit(city?: string | null): void {
  try {
    const today = new Date().toISOString().slice(0, 10)
    if (localStorage.getItem('tn_visit_day') === today) return
    localStorage.setItem('tn_visit_day', today)
  } catch { return }   // no storage → don't count (could double count)
  send({ m: 'visit', c: city ?? undefined })
}
