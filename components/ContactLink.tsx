'use client'

// One small clickable contact link (admin cards, panels, nightly finds):
// icon + short text, opens in a new tab. Renders nothing when the value
// can't be a safe link (lib/contactLinks: http(s), wa.me, tel:, Maps only).

import { CONTACT_ICONS, contactHref, mapsUrl, type ContactKind } from '@/lib/contactLinks'

const shortUrl = (href: string) => {
  try {
    const u = new URL(href)
    const s = (u.hostname.replace(/^www\./, '') + u.pathname.replace(/\/$/, '')) || href
    return s.length > 42 ? `${s.slice(0, 40)}…` : s
  } catch { return href }
}

export default function ContactLink({ kind, value, map, label, className = '' }: {
  kind: ContactKind
  value?: string | null
  /** kind 'map': the place, pin first. */
  map?: { address?: string | null; city?: string | null; lat?: number | null; lng?: number | null }
  label?: string
  className?: string
}) {
  const href = kind === 'map' && map ? mapsUrl(map) : contactHref(kind, value)
  if (!href) return null
  const text = label
    ?? (kind === 'phone' || kind === 'whatsapp' ? (value ?? '').trim()
      : kind === 'map' ? [map?.address ?? value, map?.city].filter(Boolean).join(', ') || 'Google Maps'
      : shortUrl(href))
  const tel = href.startsWith('tel:')
  return (
    <a href={href} {...(tel ? {} : { target: '_blank', rel: 'noopener noreferrer' })}
      className={`inline-flex items-center gap-1 text-xs text-brand-darker hover:underline break-all ${className}`}>
      <span aria-hidden="true">{CONTACT_ICONS[kind]}</span>
      <span>{text}</span>
      {!tel && <span aria-hidden="true">↗</span>}
    </a>
  )
}
