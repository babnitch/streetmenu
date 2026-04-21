'use client'

export const dynamic = 'force-dynamic'

import { useState, useEffect, useCallback } from 'react'
import dynamicImport from 'next/dynamic'
import Link from 'next/link'
import Image from 'next/image'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { Event } from '@/types'
import { useLanguage, useBi } from '@/lib/languageContext'
import { useCity } from '@/lib/cityContext'
import TopNav from '@/components/TopNav'

const Map = dynamicImport(() => import('@/components/Map'), { ssr: false })

// City → Mapbox center + zoom. Kept in sync with app/page.tsx.
const CITY_CENTERS: Record<string, { center: [number, number]; zoom: number }> = {
  'Yaoundé': { center: [11.5021, 3.848],    zoom: 13 },
  'Abidjan': { center: [-4.0083, 5.36],      zoom: 13 },
  'Dakar':   { center: [-17.4441, 14.6937],  zoom: 13 },
  'Lomé':    { center: [1.2123, 6.1375],     zoom: 13 },
}

const CATEGORIES = [
  'Music', 'Food', 'Sport', 'Art', 'Nightlife', 'Business', 'BT / Club', 'Autre',
]

function EventCard({ event, viewLabel, freeLabel }: { event: Event; viewLabel: string; freeLabel: string }) {
  const dateStr = new Date(event.date).toLocaleDateString('fr-FR', {
    day: '2-digit', month: 'short', year: 'numeric',
  })

  return (
    <div className="bg-white rounded-2xl overflow-hidden shadow-sm hover:shadow-md transition-shadow border border-brand-light">
      <div className="relative h-36 bg-gradient-to-br from-brand-badge to-brand">
        {event.cover_photo ? (
          <Image
            src={event.cover_photo}
            alt={event.title}
            fill
            className="object-cover"
            sizes="(max-width: 768px) 50vw, 33vw"
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-5xl">🎉</div>
        )}
        <span className="absolute top-2 left-2 bg-brand text-white text-xs font-bold px-2 py-0.5 rounded-full">
          {event.category}
        </span>
        {event.price === null || event.price === 0 ? (
          <span className="absolute top-2 right-2 bg-brand text-white text-xs font-bold px-2 py-0.5 rounded-full">
            {freeLabel}
          </span>
        ) : (
          <span className="absolute top-2 right-2 bg-black/50 text-white text-xs font-bold px-2 py-0.5 rounded-full backdrop-blur-sm">
            {Number(event.price).toLocaleString()} FCFA
          </span>
        )}
      </div>

      <div className="px-3 pt-3 pb-3">
        <p className="font-bold text-ink-primary text-sm leading-tight line-clamp-2 mb-1">
          {event.title}
        </p>
        <p className="text-xs text-brand font-medium mb-0.5">📅 {dateStr}{event.time ? ` · ${event.time}` : ''}</p>
        {event.venue && (
          <p className="text-xs text-ink-tertiary truncate">📍 {event.venue}{event.neighborhood ? `, ${event.neighborhood}` : ''}</p>
        )}
        <Link
          href={`/events/${event.id}`}
          className="mt-2.5 block w-full bg-brand hover:bg-brand-dark text-white text-center py-1.5 rounded-xl text-xs font-semibold transition-colors"
        >
          {viewLabel}
        </Link>
      </div>
    </div>
  )
}

function CardSkeleton() {
  return (
    <div className="bg-white rounded-2xl overflow-hidden shadow-sm border border-brand-light animate-pulse">
      <div className="h-36 bg-brand-light" />
      <div className="px-3 pt-3 pb-3 space-y-2">
        <div className="h-3.5 bg-surface-muted rounded-full w-3/4" />
        <div className="h-3 bg-surface-muted rounded-full w-1/2" />
        <div className="h-3 bg-surface-muted rounded-full w-2/3" />
        <div className="h-7 bg-brand-light rounded-xl mt-3" />
      </div>
    </div>
  )
}

export default function EventsPage() {
  const { t } = useLanguage()
  const bi = useBi()
  const router = useRouter()
  const { city } = useCity()
  const [events, setEvents] = useState<Event[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedCategory, setSelectedCategory] = useState('all')
  const [showMap, setShowMap] = useState(false)
  const [mapSelected, setMapSelected] = useState<Event | null>(null)

  useEffect(() => {
    async function fetchEvents() {
      const { data } = await supabase
        .from('events')
        .select('*')
        .eq('is_active', true)
        .order('date', { ascending: true })
      if (data) setEvents(data)
      setLoading(false)
    }
    fetchEvents()
  }, [])

  // TopNav map button dispatches this event; we toggle the overlay.
  useEffect(() => {
    const onToggle = () => setShowMap(prev => !prev)
    window.addEventListener('nt-toggle-map', onToggle)
    return () => window.removeEventListener('nt-toggle-map', onToggle)
  }, [])

  const filtered = events.filter(e => {
    const cityMatch = e.city === city
    const catMatch = selectedCategory === 'all' || e.category === selectedCategory
    return cityMatch && catMatch
  })

  const cityData = CITY_CENTERS[city] ?? CITY_CENTERS['Yaoundé']

  // Only events with coords can be placed on the map. Events without
  // lat/lng are shown in the list but skipped on the map view.
  const mapMarkers = filtered
    .filter(e => typeof e.lat === 'number' && typeof e.lng === 'number')
    .map(e => ({ id: e.id, name: e.title, lat: e.lat as number, lng: e.lng as number }))

  const handleMapSelect = useCallback((m: { id: string }) => {
    setMapSelected(events.find(e => e.id === m.id) ?? null)
  }, [events])

  return (
    <div className="min-h-screen bg-surface">

      <TopNav cta={{ label: t('evt.submitBtn'), href: '/events/submit' }} />

      {/* City selection lives in the TopNav CityDropdown now — filtering
          reads from useCity() above. */}

      {/* Category filter */}
      <div className="bg-white border-b border-divider">
        <div className="max-w-7xl mx-auto px-4 py-2.5 flex gap-2 overflow-x-auto scrollbar-hide">
          <button
            onClick={() => setSelectedCategory('all')}
            className={`flex-shrink-0 px-3 py-1 rounded-full text-xs font-semibold transition-colors ${
              selectedCategory === 'all'
                ? 'bg-ink-primary text-white'
                : 'bg-surface-muted text-ink-secondary hover:bg-divider'
            }`}
          >
            {t('evt.allCategories')}
          </button>
          {CATEGORIES.map(cat => (
            <button
              key={cat}
              onClick={() => setSelectedCategory(cat)}
              className={`flex-shrink-0 px-3 py-1 rounded-full text-xs font-semibold transition-colors ${
                selectedCategory === cat
                  ? 'bg-ink-primary text-white'
                  : 'bg-surface-muted text-ink-secondary hover:bg-divider'
              }`}
            >
              {cat}
            </button>
          ))}
        </div>
      </div>

      {/* Main */}
      <main className="max-w-7xl mx-auto px-4 py-5 pb-32">

        {/* Page title */}
        <div className="mb-4">
          <h1 className="text-xl font-bold text-ink-primary">{t('evt.title')}</h1>
          <p className="text-sm text-ink-tertiary">{t('evt.sub')}</p>
        </div>

        {/* Skeletons */}
        {loading && (
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
            {Array.from({ length: 6 }).map((_, i) => <CardSkeleton key={i} />)}
          </div>
        )}

        {/* Grid */}
        {!loading && filtered.length > 0 && (
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
            {filtered.map(evt => (
              <EventCard
                key={evt.id}
                event={evt}
                viewLabel={t('evt.viewDetail')}
                freeLabel={t('evt.free')}
              />
            ))}
          </div>
        )}

        {/* Empty state */}
        {!loading && filtered.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-center px-4">
            <div className="w-20 h-20 bg-brand-light rounded-3xl flex items-center justify-center text-4xl mb-5">
              🎉
            </div>
            <h2 className="text-xl font-bold text-ink-primary mb-2">{t('evt.emptyTitle')}</h2>
            <p className="text-ink-secondary text-sm mb-6 max-w-xs">{t('evt.emptySub')}</p>
            <Link
              href="/events/submit"
              className="bg-brand hover:bg-brand-dark text-white px-6 py-2.5 rounded-xl font-semibold text-sm transition-colors"
            >
              {t('evt.submitBtn')}
            </Link>
          </div>
        )}

      </main>

      {/* Floating submit (mobile) — bottom-20 clears the 56px BottomNav
          with breathing room; mobile-only since desktop has the inline
          submit button inside the TopNav area. */}
      <div className="sm:hidden fixed bottom-20 right-4 z-30">
        <Link
          href="/events/submit"
          className="bg-brand hover:bg-brand-dark text-white px-5 py-3 rounded-full shadow-card flex items-center gap-2 text-sm font-semibold transition-colors"
        >
          {t('evt.submitBtn')}
        </Link>
      </div>

      {/* Map overlay — triggered by the TopNav 🗺 button via the
          nt-toggle-map custom event. Drops a pin for every event with
          coordinates; events without lat/lng stay in the list view. */}
      {showMap && (
        <div className="fixed inset-0 z-50 flex flex-col bg-surface">
          <div className="h-14 flex-shrink-0 bg-surface border-b border-divider flex items-center justify-between px-4">
            <span className="font-semibold text-ink-primary text-sm">
              {bi('Événements à', 'Events in')} {city}
            </span>
            <button
              onClick={() => { setShowMap(false); setMapSelected(null) }}
              className="bg-surface-muted hover:bg-divider text-ink-primary px-4 py-1.5 rounded-full text-sm font-semibold transition-colors"
            >
              {t('list.closeMap')}
            </button>
          </div>

          <div className="flex-1 relative overflow-hidden">
            <Map
              restaurants={mapMarkers}
              onSelectRestaurant={handleMapSelect}
              selectedId={mapSelected?.id ?? null}
              center={cityData.center}
              zoom={cityData.zoom}
            />

            {mapMarkers.length === 0 && (
              <div className="pointer-events-none absolute inset-x-0 top-4 flex justify-center">
                <div className="pointer-events-auto bg-white/95 backdrop-blur-sm border border-divider rounded-full px-4 py-2 text-xs font-semibold text-ink-secondary shadow-card">
                  {bi('Aucun événement géolocalisé', 'No events with a location yet')}
                </div>
              </div>
            )}

            {mapSelected && (
              <>
                <div
                  className="absolute inset-0 bg-black/30 md:hidden"
                  onClick={() => setMapSelected(null)}
                />
                <div className="absolute bottom-0 left-0 right-0 z-10 md:top-0 md:right-auto md:w-80 bg-surface rounded-t-3xl md:rounded-none md:border-r md:border-divider shadow-2xl overflow-hidden">
                  <div className="md:hidden w-10 h-1 bg-divider rounded-full mx-auto mt-3 mb-1" />
                  <div className="p-4">
                    <p className="font-bold text-ink-primary text-base leading-tight mb-1">{mapSelected.title}</p>
                    <p className="text-xs text-brand font-medium mb-0.5">
                      📅 {new Date(mapSelected.date).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' })}
                      {mapSelected.time ? ` · ${mapSelected.time}` : ''}
                    </p>
                    {mapSelected.venue && (
                      <p className="text-xs text-ink-tertiary truncate mb-3">
                        📍 {mapSelected.venue}{mapSelected.neighborhood ? `, ${mapSelected.neighborhood}` : ''}
                      </p>
                    )}
                    <button
                      onClick={() => router.push(`/events/${mapSelected.id}`)}
                      className="w-full bg-brand hover:bg-brand-dark text-white text-center py-2 rounded-xl text-sm font-semibold transition-colors"
                    >
                      {t('evt.viewDetail')}
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}

    </div>
  )
}
