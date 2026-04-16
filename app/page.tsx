'use client'

export const dynamic = 'force-dynamic'

import { useState, useEffect, useCallback } from 'react'
import dynamicImport from 'next/dynamic'
import Link from 'next/link'
import Image from 'next/image'
import { supabase } from '@/lib/supabase'
import { Restaurant } from '@/types'
import RestaurantSidebar from '@/components/RestaurantSidebar'
import TopNav from '@/components/TopNav'
import { useLanguage } from '@/lib/languageContext'
import { useAuth } from '@/lib/authContext'

const Map = dynamicImport(() => import('@/components/Map'), { ssr: false })

// City data — [lng, lat] for Mapbox
const CITIES: { name: string; center: [number, number]; zoom: number }[] = [
  { name: 'Yaoundé',  center: [11.5021, 3.848],    zoom: 13 },
  { name: 'Abidjan',  center: [-4.0083, 5.36],      zoom: 13 },
  { name: 'Dakar',    center: [-17.4441, 14.6937],  zoom: 13 },
  { name: 'Lomé',     center: [1.2123, 6.1375],     zoom: 13 },
]

// ─── Card ────────────────────────────────────────────────────────────────────
function RestaurantCard({
  restaurant,
  viewMenuLabel,
  openLabel,
  closedLabel,
}: {
  restaurant: Restaurant
  viewMenuLabel: string
  openLabel: string
  closedLabel: string
}) {
  const cuisine = restaurant.cuisine_type || restaurant.description
  const neighborhood = restaurant.neighborhood || restaurant.address

  return (
    <div className="bg-white rounded-2xl overflow-hidden shadow-sm hover:shadow-md transition-shadow border border-orange-50">
      {/* Photo */}
      <div className="relative h-28 sm:h-36 bg-gradient-to-br from-orange-200 to-orange-400">
        {restaurant.logo_url ? (
          <Image
            src={restaurant.logo_url}
            alt={restaurant.name}
            fill
            className="object-cover"
            sizes="(max-width: 768px) 50vw, 33vw"
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-4xl">
            🍽️
          </div>
        )}
        {/* Open/closed badge */}
        <span className={`absolute top-2 right-2 text-xs font-bold px-2 py-0.5 rounded-full ${
          restaurant.is_open
            ? 'bg-green-500 text-white'
            : 'bg-black/40 text-white backdrop-blur-sm'
        }`}>
          {restaurant.is_open ? openLabel : closedLabel}
        </span>
      </div>

      {/* Body */}
      <div className="px-2.5 pt-2.5 pb-3">
        <p className="font-bold text-gray-900 text-sm leading-tight line-clamp-1 mb-0.5">
          {restaurant.name}
        </p>
        {cuisine && (
          <p className="text-xs text-orange-500 font-medium truncate">{cuisine}</p>
        )}
        {neighborhood && (
          <p className="text-xs text-gray-400 truncate mt-0.5">📍 {neighborhood}</p>
        )}
        <Link
          href={`/restaurant/${restaurant.id}`}
          className="mt-2.5 block w-full bg-orange-500 hover:bg-orange-600 text-white text-center py-1.5 rounded-xl text-xs font-semibold transition-colors"
        >
          {viewMenuLabel}
        </Link>
      </div>
    </div>
  )
}

// ─── Skeleton loader ──────────────────────────────────────────────────────────
function CardSkeleton() {
  return (
    <div className="bg-white rounded-2xl overflow-hidden shadow-sm border border-orange-50 animate-pulse">
      <div className="h-28 sm:h-36 bg-orange-100" />
      <div className="px-2.5 pt-2.5 pb-3 space-y-2">
        <div className="h-3.5 bg-gray-100 rounded-full w-3/4" />
        <div className="h-3 bg-gray-100 rounded-full w-1/2" />
        <div className="h-3 bg-gray-100 rounded-full w-2/3" />
        <div className="h-7 bg-orange-100 rounded-xl mt-3" />
      </div>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────
export default function HomePage() {
  const [restaurants, setRestaurants] = useState<Restaurant[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedCity, setSelectedCity] = useState('Yaoundé')
  const [showMap, setShowMap] = useState(false)
  const [mapSelected, setMapSelected] = useState<Restaurant | null>(null)
  const [bannerDismissed, setBannerDismissed] = useState(true)
  const { t } = useLanguage()
  const { user, loading: authLoading } = useAuth()

  useEffect(() => {
    const dismissed = localStorage.getItem('banner_dismissed')
    if (!dismissed) setBannerDismissed(false)
  }, [])

  useEffect(() => {
    async function fetchRestaurants() {
      const { data } = await supabase
        .from('restaurants')
        .select('*')
        .eq('is_active', true)
        .order('created_at', { ascending: false })
      if (data) setRestaurants(data)
      setLoading(false)
    }
    fetchRestaurants()
  }, [])

  const handleMapSelect = useCallback((r: Restaurant) => setMapSelected(r), [])

  const cityData = CITIES.find(c => c.name === selectedCity) ?? CITIES[0]
  const filtered = restaurants.filter(r => r.city === selectedCity)
  const openCount = filtered.filter(r => r.is_open).length

  return (
    <div className="min-h-screen" style={{ background: '#fffaf5' }}>

      {/* ── Sticky Header ─────────────────────────────────────────────── */}
      <TopNav cta={{ label: t('nav.join'), href: '/join' }} />

      {/* ── Promo Banner ──────────────────────────────────────────────── */}
      {!authLoading && !user && !bannerDismissed && (
        <div className="bg-orange-500 text-white px-4 py-2.5 flex items-center justify-between gap-3">
          <Link href="/account" className="flex-1 text-center text-sm font-semibold hover:underline">
            🎉 {t('banner.text')} — {t('banner.cta')}
          </Link>
          <button
            onClick={() => { setBannerDismissed(true); localStorage.setItem('banner_dismissed', '1') }}
            className="text-white/80 hover:text-white flex-shrink-0 text-lg leading-none"
            aria-label="Fermer"
          >
            ✕
          </button>
        </div>
      )}

      {/* ── City Selector ─────────────────────────────────────────────── */}
      <div className="bg-white border-b border-gray-100">
        <div className="max-w-5xl mx-auto px-4 py-3 flex gap-2 overflow-x-auto scrollbar-hide">
          {CITIES.map(city => (
            <button
              key={city.name}
              onClick={() => setSelectedCity(city.name)}
              className={`flex-shrink-0 px-4 py-1.5 rounded-full text-sm font-semibold transition-colors ${
                selectedCity === city.name
                  ? 'bg-orange-500 text-white shadow-sm'
                  : 'bg-orange-50 text-gray-600 hover:bg-orange-100 border border-transparent'
              }`}
            >
              {city.name}
            </button>
          ))}
        </div>
      </div>

      {/* ── Main Content ──────────────────────────────────────────────── */}
      <main className="max-w-5xl mx-auto px-4 py-5 pb-24">

        {/* Count row */}
        {!loading && filtered.length > 0 && (
          <p className="text-sm text-gray-500 mb-4">
            <span className="font-semibold text-gray-700">{filtered.length}</span>{' '}
            {t('list.count')}
            {openCount > 0 && (
              <> · <span className="text-green-600 font-semibold">{openCount}</span> {t('list.openCount')}</>
            )}
          </p>
        )}

        {/* Loading skeletons */}
        {loading && (
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
            {Array.from({ length: 6 }).map((_, i) => <CardSkeleton key={i} />)}
          </div>
        )}

        {/* Restaurant grid */}
        {!loading && filtered.length > 0 && (
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
            {filtered.map(r => (
              <RestaurantCard
                key={r.id}
                restaurant={r}
                viewMenuLabel={t('list.viewMenuBtn')}
                openLabel={t('list.openBadge')}
                closedLabel={t('list.closedBadge')}
              />
            ))}
          </div>
        )}

        {/* Empty state */}
        {!loading && filtered.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-center px-4">
            <div className="w-20 h-20 bg-orange-100 rounded-3xl flex items-center justify-center text-4xl mb-5">
              🏪
            </div>
            <h2 className="text-xl font-bold text-gray-900 mb-2">{t('list.emptyTitle')}</h2>
            <p className="text-gray-500 text-sm mb-1 max-w-xs">{t('list.emptySub')}</p>
            <p className="text-gray-400 text-xs mb-6">{selectedCity}</p>
            <Link
              href="/join"
              className="bg-orange-500 hover:bg-orange-600 text-white px-6 py-2.5 rounded-xl font-semibold text-sm transition-colors"
            >
              {t('list.joinBtn')}
            </Link>
          </div>
        )}

      </main>

      {/* ── Floating "Join us" (mobile only) ─────────────────────────── */}
      <div className="sm:hidden fixed bottom-6 left-4 z-30">
        <Link
          href="/join"
          className="bg-white border border-orange-200 text-orange-500 text-sm font-semibold px-4 py-2.5 rounded-2xl shadow-md flex items-center gap-1.5"
        >
          {t('nav.join')}
        </Link>
      </div>

      {/* ── Floating Map Button ───────────────────────────────────────── */}
      <button
        onClick={() => setShowMap(true)}
        className="fixed bottom-6 right-4 z-30 bg-orange-500 hover:bg-orange-600 text-white px-5 py-3 rounded-2xl shadow-xl shadow-orange-200 flex items-center gap-2 text-sm font-semibold transition-colors"
      >
        {t('list.viewMap')}
      </button>

      {/* ── Map Overlay ───────────────────────────────────────────────── */}
      {showMap && (
        <div className="fixed inset-0 z-50 flex flex-col bg-white">
          {/* Map header bar */}
          <div className="h-14 flex-shrink-0 bg-white border-b border-gray-100 flex items-center justify-between px-4 shadow-sm">
            <span className="font-semibold text-gray-900 text-sm">
              {t('list.mapIn')} {selectedCity}
            </span>
            <button
              onClick={() => { setShowMap(false); setMapSelected(null) }}
              className="bg-gray-100 hover:bg-gray-200 text-gray-700 px-4 py-1.5 rounded-xl text-sm font-semibold transition-colors"
            >
              {t('list.closeMap')}
            </button>
          </div>

          {/* Map + sidebar */}
          <div className="flex-1 relative overflow-hidden">
            <Map
              restaurants={filtered}
              onSelectRestaurant={handleMapSelect}
              selectedId={mapSelected?.id ?? null}
              center={cityData.center}
              zoom={cityData.zoom}
            />

            {/* Sidebar over map when marker selected */}
            {mapSelected && (
              <>
                <div
                  className="absolute inset-0 bg-black/30 md:hidden"
                  onClick={() => setMapSelected(null)}
                />
                <div className="absolute bottom-0 left-0 right-0 z-10 md:top-0 md:right-auto md:w-80 bg-white rounded-t-3xl md:rounded-none md:border-r md:border-gray-100 shadow-2xl overflow-hidden">
                  <div className="md:hidden w-10 h-1 bg-gray-200 rounded-full mx-auto mt-3 mb-1" />
                  <div className="h-[60vh] md:h-full">
                    <RestaurantSidebar
                      restaurant={mapSelected}
                      onClose={() => setMapSelected(null)}
                    />
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
