// Restaurant links (I2): Instagram, Facebook, TikTok, website — public,
// shown on "Infos du restaurant", edited by the owner/manager and the admin.
// Client-safe.

export const LINK_FIELDS = ['instagram_url', 'facebook_url', 'tiktok_url', 'website_url'] as const
export type LinkField = typeof LINK_FIELDS[number]
export type RestaurantLinks = Partial<Record<LinkField, string | null>>

export const LINK_LABELS: Record<LinkField, { fr: string; en: string; icon: string; host?: RegExp }> = {
  instagram_url: { fr: 'Instagram', en: 'Instagram', icon: '📸', host: /(^|\.)instagram\.com$/i },
  facebook_url:  { fr: 'Facebook', en: 'Facebook', icon: '📘', host: /(^|\.)(facebook\.com|fb\.com|fb\.me)$/i },
  tiktok_url:    { fr: 'TikTok', en: 'TikTok', icon: '🎵', host: /(^|\.)tiktok\.com$/i },
  website_url:   { fr: 'Site web', en: 'Website', icon: '🌐' },
}

export type LinksValidation = { ok: true; links: RestaurantLinks } | { ok: false; field: LinkField; error: string }

// Only the fields present in `raw` are returned; '' / null clears a link.
export function validateLinks(raw: Record<string, unknown>): LinksValidation {
  const links: RestaurantLinks = {}
  for (const f of LINK_FIELDS) {
    if (!(f in raw)) continue
    const v = typeof raw[f] === 'string' ? (raw[f] as string).trim() : ''
    if (!v) { links[f] = null; continue }
    let url: URL
    try { url = new URL(v) } catch { return { ok: false, field: f, error: 'Lien invalide (https://…) / Invalid link (https://…)' } }
    if (!/^https?:$/.test(url.protocol)) return { ok: false, field: f, error: 'Lien invalide (https://…) / Invalid link (https://…)' }
    const host = LINK_LABELS[f].host
    if (host && !host.test(url.hostname)) return { ok: false, field: f, error: `Lien ${LINK_LABELS[f].fr} attendu / ${LINK_LABELS[f].en} link expected` }
    links[f] = v.slice(0, 500)
  }
  return { ok: true, links }
}

export function hasAnyLink(r: RestaurantLinks): boolean {
  return LINK_FIELDS.some(f => !!r[f])
}
