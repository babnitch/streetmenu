// Contact links for the admin cards and panels (restaurants, events, nightly
// finds): turn a stored value into a safe link, or null when it can't be one.
// Only http(s), wa.me, tel: and Google Maps links are ever built; anything
// else (javascript:, data:, mailto:…) gives null. Client-safe, no fetching.

export type ContactKind = 'instagram' | 'facebook' | 'tiktok' | 'website' | 'link' | 'ticket' | 'source' | 'whatsapp' | 'phone' | 'map'

export const CONTACT_ICONS: Record<ContactKind, string> = {
  instagram: '📸', facebook: '📘', tiktok: '🎵', website: '🌐', link: '🔗', ticket: '🎟️', source: '🔎',
  whatsapp: '💬', phone: '📞', map: '📍',
}

const SOCIAL: Record<'instagram' | 'facebook' | 'tiktok', { host: RegExp; build: (h: string) => string }> = {
  instagram: { host: /(^|\.)instagram\.com$/i, build: h => `https://www.instagram.com/${h}/` },
  facebook:  { host: /(^|\.)(facebook\.com|fb\.com|fb\.me)$/i, build: h => `https://www.facebook.com/${h}` },
  tiktok:    { host: /(^|\.)tiktok\.com$/i, build: h => `https://www.tiktok.com/@${h}` },
}

const HANDLE = /^@?([A-Za-z0-9._-]{1,80})$/
const DOMAIN_START = /^[a-z0-9-]+(\.[a-z0-9-]+)+([/?#:]|$)/i

/** An absolute http(s) URL, or null. "example.com/x" gets https:// added. */
export function safeHttpUrl(raw: string | null | undefined): string | null {
  const v = (raw ?? '').trim()
  if (!v || /\s/.test(v)) return null
  let candidate = v
  if (!/^[a-z][a-z0-9+.-]*:/i.test(v)) {
    if (v.startsWith('//')) candidate = `https:${v}`
    else if (DOMAIN_START.test(v)) candidate = `https://${v}`
    else return null
  }
  let url: URL
  try { url = new URL(candidate) } catch { return null }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (!url.hostname || url.username || url.password) return null
  return url.href
}

/** Instagram / Facebook / TikTok: a full link, or a handle ("@x" or "x"). */
export function socialUrl(kind: 'instagram' | 'facebook' | 'tiktok', raw: string | null | undefined): string | null {
  const v = (raw ?? '').trim()
  if (!v) return null
  const s = SOCIAL[kind]
  const handle = v.match(HANDLE)
  // A bare word with a dot could be a domain ("bamboo.lounge" is a valid
  // Instagram handle too): a handle wins unless it names the network's host.
  if (handle && !s.host.test(handle[1].split('/')[0])) return s.build(handle[1])
  const url = safeHttpUrl(v)
  if (!url) return null
  return s.host.test(new URL(url).hostname) ? url : null
}

/** Digits of a phone number with at least 8 of them, or null. */
function phoneDigits(raw: string | null | undefined): string | null {
  const v = (raw ?? '').trim()
  if (!v || /[^0-9+\s().-]/.test(v)) return null
  const d = v.replace(/\D/g, '')
  return d.length >= 8 && d.length <= 15 ? d : null
}

export const whatsappUrl = (raw: string | null | undefined): string | null => {
  const d = phoneDigits(raw)
  return d ? `https://wa.me/${d}` : null
}

export const telUrl = (raw: string | null | undefined): string | null => {
  const d = phoneDigits(raw)
  return d ? `tel:${(raw ?? '').trim().startsWith('+') ? '+' : ''}${d}` : null
}

/** Google Maps: the pin when there is one, else the address (+ city). */
export function mapsUrl(p: { address?: string | null; city?: string | null; lat?: number | null; lng?: number | null }): string | null {
  const lat = Number(p.lat), lng = Number(p.lng)
  if (p.lat != null && p.lng != null && Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0)) {
    return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`
  }
  const q = [p.address, p.city].map(x => (x ?? '').trim()).filter(Boolean)
  if (!p.address?.trim()) return null
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q.join(', '))}`
}

/** The link for a stored value of this kind, or null. */
export function contactHref(kind: ContactKind, value: string | null | undefined): string | null {
  switch (kind) {
    case 'instagram': case 'facebook': case 'tiktok': return socialUrl(kind, value)
    case 'whatsapp': return whatsappUrl(value)
    case 'phone': return telUrl(value)
    case 'map': return mapsUrl({ address: value })
    default: return safeHttpUrl(value)
  }
}
