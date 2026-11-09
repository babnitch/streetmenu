// Reading a ticketing site: the RSS feed (which event pages exist) and the
// schema.org Event data on each event page (the facts). Pure — no network.
// Only FACTS come out: title, dates, venue, city, price, organiser, link.
// Never a description, never an image.

import { validateEventRange, normalizeEndDate } from '@/lib/eventDate'

export const DISCOVERY_TZ = 'Africa/Douala'

export interface FeedItem { url: string; category: string | null }

export interface FoundEvent {
  title: string
  start_date: string
  start_time: string | null
  end_date: string | null
  end_time: string | null
  venue: string | null
  city: string
  category: string
  price_fcfa: number | null
  price_is_from: boolean
  organiser_name: string | null
  organiser_url: string | null
  ticket_url: string
}

export function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
}

const clean = (s: unknown, max: number): string | null => {
  if (typeof s !== 'string') return null
  const t = decodeEntities(s).replace(/\s+/g, ' ').trim()
  return t ? t.slice(0, max) : null
}

/** Event page links in an RSS feed, on `host` only, without query or anchor. */
export function parseRssItems(xml: string, host: string): FeedItem[] {
  const out: FeedItem[] = []
  const seen = new Set<string>()
  for (const item of xml.match(/<item\b[\s\S]*?<\/item>/gi) ?? []) {
    const link = clean(item.match(/<link>([\s\S]*?)<\/link>/i)?.[1], 500)
    if (!link) continue
    let u: URL
    try { u = new URL(link) } catch { continue }
    if (u.protocol !== 'https:' || u.hostname.replace(/^www\./, '') !== host.replace(/^www\./, '')) continue
    u.search = ''; u.hash = ''
    const url = u.toString()
    if (seen.has(url)) continue
    seen.add(url)
    out.push({ url, category: clean(item.match(/<category>([\s\S]*?)<\/category>/i)?.[1], 80) })
  }
  return out
}

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : v == null ? [] : [v])
const hasType = (o: Json, t: string): boolean => asArray(o['@type']).some(x => x === t)

/** Every schema.org Event in the page (graphs, lists and series opened up). */
export function extractJsonLdEvents(html: string): Json[] {
  const events: Json[] = []
  const blocks = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi) ?? []
  const visit = (node: unknown, inherited: Json | null) => {
    for (const n of asArray(node)) {
      if (!isObj(n)) continue
      if (n['@graph']) visit(n['@graph'], inherited)
      if (hasType(n, 'EventSeries')) {
        visit(n.subEvent, { organizer: n.organizer })
      } else if (asArray(n['@type']).some(t => typeof t === 'string' && /Event$/.test(t))) {
        events.push(inherited && !n.organizer ? { ...n, organizer: inherited.organizer } : n)
      }
    }
  }
  for (const b of blocks) {
    const body = b.replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, '')
    try { visit(JSON.parse(body), null) } catch { /* broken block: skip it */ }
  }
  return events
}

/** Local date + time in Douala from an ISO date or date-time. */
export function localParts(iso: unknown): { date: string; time: string | null } | null {
  if (typeof iso !== 'string') return null
  const s = iso.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return { date: s, time: null }
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return null
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: DISCOVERY_TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).map(x => [x.type, x.value]))
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` }
}

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

/** Which of `cities` the place is in, or null (another city: not ours). */
export function cityOf(location: unknown, cities: string[]): string | null {
  const texts: string[] = []
  for (const loc of asArray(location)) {
    if (!isObj(loc)) continue
    for (const a of asArray(loc.address)) {
      if (typeof a === 'string') texts.push(a)
      else if (isObj(a)) for (const k of ['addressLocality', 'streetAddress']) if (typeof a[k] === 'string') texts.push(a[k] as string)
    }
    if (typeof loc.name === 'string') texts.push(loc.name)
  }
  for (const t of texts) {
    const ft = fold(t)
    const hit = cities.find(c => new RegExp(`(^|[^a-z])${fold(c).replace(/[^a-z0-9]/g, '.')}([^a-z]|$)`).test(ft))
    if (hit) return hit
  }
  return null
}

/** Ticketing-site category → our event category code. */
export function mapCategory(hint: string | null | undefined): string {
  const h = fold(hint ?? '')
  if (/concert|musique|music/.test(h)) return 'Concert'
  if (/festival|spectacle|carnaval/.test(h)) return 'Festival'
  if (/cinema|theatre|film|exposition|art|culture|litter/.test(h)) return 'Culture'
  if (/sport|fitness/.test(h)) return 'Sport'
  if (/soiree|club|party|night|nightlife/.test(h)) return 'BT/Club'
  if (/gastronom|food|culinaire|cuisine|restaurant/.test(h)) return 'Gastronomie'
  if (/enfant|famille|kids|family/.test(h)) return 'Enfants'
  if (/business|conference|formation|atelier|seminaire|tech|salon/.test(h)) return 'Business'
  return 'Autre'
}

function priceOf(offers: unknown): { price: number | null; from: boolean } {
  const prices = asArray(offers).filter(isObj)
    .filter(o => !o.priceCurrency || o.priceCurrency === 'XAF')
    .map(o => Number(o.price)).filter(n => Number.isFinite(n) && n >= 0)
  if (!prices.length) return { price: null, from: false }
  const min = Math.min(...prices)
  return { price: Math.round(min), from: new Set(prices).size > 1 }
}

/** One page Event → the facts we keep, or null (cancelled, not ours, no date). */
export function toFoundEvent(ev: Json, pageUrl: string, categoryHint: string | null, cities: string[]): FoundEvent | null {
  const status = String(ev.eventStatus ?? '')
  if (/Cancelled|Postponed/i.test(status)) return null
  const title = clean(ev.name, 140)
  const start = localParts(ev.startDate)
  if (!title || !start) return null
  const city = cityOf(ev.location, cities)
  if (!city) return null

  let end = localParts(ev.endDate)
  if (end && end.date < start.date) end = null
  let range = { date: start.date, time: start.time, end_date: end?.date ?? null, end_time: end?.time ?? null }
  if (validateEventRange(range)) range = { ...range, end_time: null }
  if (validateEventRange(range)) range = { ...range, end_date: null, end_time: null }
  if (validateEventRange(range)) return null

  const loc = asArray(ev.location).find(isObj)
  const org = asArray(ev.organizer).find(isObj)
  const { price, from } = priceOf(ev.offers)
  const orgUrl = typeof org?.url === 'string' && /^https:\/\//.test(org.url) ? org.url.slice(0, 500) : null

  return {
    title,
    start_date: range.date,
    start_time: range.time,
    end_date: normalizeEndDate(range.date, range.end_date),
    end_time: range.end_time,
    venue: clean(loc?.name, 120),
    city,
    category: mapCategory(categoryHint),
    price_fcfa: price,
    price_is_from: from,
    organiser_name: clean(org?.name, 80),
    organiser_url: orgUrl,
    ticket_url: pageUrl,
  }
}
