'use client'

// /lieux — Loisirs › Lieux (I4): the city's places (monuments, museums,
// nature, markets…), category chips and an in-place search.

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import TopNav from '@/components/TopNav'
import PlaceCard from '@/components/PlaceCard'
import SearchField from '@/components/SearchField'
import { openAddSheet } from '@/components/AddSheet'
import { useBi, useLanguage } from '@/lib/languageContext'
import { useCity } from '@/lib/cityContext'
import { matchesSearch } from '@/lib/textSearch'
import { PLACE_CATEGORIES, placeCategoryLabel, type PublicPlace } from '@/lib/places'

export default function PlacesPage() {
  const bi = useBi()
  const { locale } = useLanguage()
  const { city } = useCity()
  const [places, setPlaces] = useState<PublicPlace[] | null>(null)
  const [category, setCategory] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  useEffect(() => {
    let live = true
    setPlaces(null)
    fetch(`/api/places?city=${encodeURIComponent(city)}`, { cache: 'no-store' })
      .then(r => r.json()).then(d => { if (live) setPlaces(d?.places ?? []) }).catch(() => { if (live) setPlaces([]) })
    return () => { live = false }
  }, [city])

  const present = useMemo(() => new Set((places ?? []).map(p => p.category)), [places])
  const shown = useMemo(() => (places ?? []).filter(p =>
    (!category || p.category === category)
    && matchesSearch(query, [p.title_fr, p.title_en, p.area, p.description_fr, p.description_en, placeCategoryLabel(p.category, locale)])),
  [places, category, query, locale])

  return (
    <div className="min-h-screen bg-surface">
      <TopNav />
      <section className="bg-ink-primary text-white">
        <div className="max-w-3xl mx-auto px-4 pt-5 pb-6">
          <div className="flex items-center justify-between gap-3">
            <h1 className="text-2xl font-black leading-tight">{bi('Loisirs', 'Leisure')}</h1>
            <button type="button" onClick={openAddSheet}
              className="flex-shrink-0 bg-brand hover:bg-brand-dark text-white text-sm font-bold px-4 py-2 rounded-full">
              + {bi('Ajouter', 'Add')}
            </button>
          </div>
          <div className="mt-3 inline-flex bg-white/10 rounded-full p-1 text-sm font-semibold" role="tablist">
            <Link role="tab" aria-selected="false" href="/events" className="px-4 py-1.5 rounded-full text-white/80">{bi('Événements', 'Events')}</Link>
            <span role="tab" aria-selected="true" className="px-4 py-1.5 rounded-full bg-white text-ink-primary">{bi('Lieux', 'Places')}</span>
          </div>
          <p className="mt-2 text-sm text-white/80">{bi(`Que faire à ${city} : monuments, musées, nature, marchés`, `What to do in ${city}: monuments, museums, nature, markets`)}</p>
          <div className="mt-3">
            <SearchField dark value={query} onChange={setQuery} placeholder={bi('Rechercher un lieu, un quartier', 'Search a place, an area')} />
          </div>
        </div>
      </section>
      <main className="max-w-3xl mx-auto px-4 pt-4 pb-28 md:pb-12">
        <div className="flex gap-2 overflow-x-auto pb-3 mb-3 -mx-4 px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {PLACE_CATEGORIES.filter(c => present.has(c.id) || category === c.id).map(c => (
            <button key={c.id} type="button" aria-pressed={category === c.id} onClick={() => setCategory(category === c.id ? null : c.id)}
              className={`flex-shrink-0 px-3.5 py-1.5 rounded-full text-sm font-semibold border transition-colors ${category === c.id ? 'bg-ink-primary text-white border-ink-primary' : 'bg-white text-ink-secondary border-divider'}`}>
              {c.icon} {locale === 'en' ? c.en : c.fr}
            </button>
          ))}
        </div>
        {places === null ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3" aria-hidden="true">
            {[0, 1, 2, 3].map(i => <div key={i} className="aspect-[16/9] rounded-2xl bg-surface-muted animate-pulse" />)}
          </div>
        ) : shown.length === 0 ? (
          <p className="text-sm text-ink-tertiary mt-6 text-center">
            {places.length === 0 ? bi(`Pas encore de lieu à ${city}.`, `No places in ${city} yet.`) : bi('Aucun lieu pour ces critères.', 'No places match.')}
          </p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {shown.map(p => <PlaceCard key={p.id} place={p} />)}
          </div>
        )}
      </main>
    </div>
  )
}
