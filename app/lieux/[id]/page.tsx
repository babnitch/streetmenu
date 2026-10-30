'use client'

// /lieux/[id] — one place (I4): photo or generated cover, title, text, "Bon
// à savoir", hours, price, Itinéraire (map app), links. Events held here
// come later (events.place_id).

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Image from 'next/image'
import TopNav from '@/components/TopNav'
import GeneratedCover from '@/components/GeneratedCover'
import PhotoCredit from '@/components/PhotoCredit'
import { useBi, useLanguage } from '@/lib/languageContext'
import { useDataMode } from '@/lib/dataMode'
import { directionsUrl, pick, placeCategoryLabel, type PublicPlace } from '@/lib/places'

export default function PlacePage() {
  const bi = useBi()
  const { locale } = useLanguage()
  const { isLowData } = useDataMode()
  const router = useRouter()
  const { id } = useParams<{ id: string }>()
  const [place, setPlace] = useState<(PublicPlace & { status?: string }) | null | 'missing'>(null)

  useEffect(() => {
    fetch(`/api/places/${id}`, { cache: 'no-store' }).then(r => r.ok ? r.json() : null)
      .then(d => setPlace(d?.place ?? 'missing')).catch(() => setPlace('missing'))
  }, [id])

  if (place === null) return <div className="min-h-screen bg-surface"><TopNav /><p className="text-center mt-16 text-ink-tertiary">…</p></div>
  if (place === 'missing') {
    return (
      <div className="min-h-screen bg-surface"><TopNav />
        <p className="text-center mt-16 text-ink-secondary">{bi('Lieu introuvable', 'Place not found')}</p>
      </div>
    )
  }
  const title = pick(place, 'title', locale)
  const headline = pick(place, 'headline', locale)
  const description = pick(place, 'description', locale)
  const tip = pick(place, 'tip', locale)
  const links = [
    place.official_link && { href: place.official_link, label: bi('Site officiel', 'Official site'), icon: '🌐' },
    place.instagram_url && { href: place.instagram_url, label: 'Instagram', icon: '📸' },
    place.facebook_url && { href: place.facebook_url, label: 'Facebook', icon: '📘' },
    place.tiktok_url && { href: place.tiktok_url, label: 'TikTok', icon: '🎵' },
  ].filter(Boolean) as Array<{ href: string; label: string; icon: string }>

  return (
    <div className="min-h-screen bg-surface">
      <TopNav />
      <div className="relative h-56 md:h-72 md:max-w-2xl md:mx-auto md:mt-4 md:rounded-2xl overflow-hidden bg-surface-muted">
        {place.cover_url && !isLowData
          ? <><Image src={place.cover_url} alt={title} fill className="object-cover" sizes="(min-width: 768px) 672px, 100vw" priority />
              <PhotoCredit credit={place.photo_credit} url={place.photo_credit_url} /></>
          : <GeneratedCover kind="place" size="hero" title={title} area={place.area} category={placeCategoryLabel(place.category, locale)} />}
        <button onClick={() => router.back()} aria-label={bi('Retour', 'Back')}
          className="absolute top-4 left-4 bg-surface/95 rounded-full w-10 h-10 flex items-center justify-center text-ink-primary shadow-card">←</button>
      </div>
      <main className="max-w-2xl mx-auto px-4 pb-28 md:pb-12">
        {place.status && place.status !== 'active' && (
          <p className="mt-3 rounded-xl bg-amber-50 text-amber-800 text-sm font-semibold px-3 py-2">
            {place.status === 'pending' ? bi('En attente de validation (aperçu admin)', 'Pending approval (admin preview)') : bi('Masqué (aperçu admin)', 'Hidden (admin preview)')}
          </p>
        )}
        <p className="mt-4 text-xs font-bold uppercase tracking-wide text-brand-darker">{placeCategoryLabel(place.category, locale)}</p>
        <h1 className="text-2xl font-black text-ink-primary leading-tight">{title}</h1>
        {headline && <p className="mt-1 text-base italic text-ink-secondary">{headline}</p>}
        <p className="text-sm text-ink-secondary mt-1">📍 {[place.area, place.city].filter(Boolean).join(', ')}</p>
        <a href={directionsUrl(place)} target="_blank" rel="noopener noreferrer"
          className="mt-3 inline-flex items-center gap-2 bg-brand hover:bg-brand-dark text-white px-4 py-2 rounded-full text-sm font-semibold">
          🧭 {bi('Itinéraire', 'Directions')}
        </a>
        {description && <div className="mt-5 space-y-3 text-ink-primary leading-relaxed">{description.split(/\n{2,}/).map((p, i) => <p key={i}>{p}</p>)}</div>}
        {tip && (
          <section className="mt-6 rounded-2xl bg-brand-light/60 border border-brand-badge/40 p-4">
            <h2 className="text-sm font-bold text-brand-darker">💡 {bi('Bon à savoir', 'Good to know')}</h2>
            <p className="mt-1 text-sm text-ink-primary leading-relaxed">{tip}</p>
          </section>
        )}
        {(place.hours || place.price) && (
          <ul className="mt-5 divide-y divide-divider border-y border-divider text-sm">
            {place.hours && <li className="py-3 flex gap-3"><span aria-hidden="true">🕐</span><span>{place.hours}</span></li>}
            {place.price && <li className="py-3 flex gap-3"><span aria-hidden="true">💰</span><span>{place.price}</span></li>}
          </ul>
        )}
        {links.length > 0 && (
          <div className="mt-5 flex flex-wrap gap-2">
            {links.map(l => (
              <a key={l.href} href={l.href} target="_blank" rel="noopener noreferrer"
                className="text-sm font-semibold px-3 py-1.5 rounded-full border border-divider bg-white hover:bg-surface-muted">{l.icon} {l.label}</a>
            ))}
          </div>
        )}
      </main>
    </div>
  )
}
