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

// ─── Restaurant card — full-width 16:9 image, bold name, meta + cuisine pill ─
function RestaurantCard({
  restaurant,
}: {
  restaurant: Restaurant
}) {
  const neighborhood = restaurant.neighborhood || restaurant.address
  const location = [neighborhood, restaurant.city].filter(Boolean).join(', ')
  const cuisine = restaurant.cuisine_type || restaurant.description
  const initial = (restaurant.name?.[0] ?? '?').toUpperCase()
  const heroImage = restaurant.image_url || restaurant.logo_url

  return (
    <Link href={`/restaurant/${restaurant.id}`} className="group block">
      {/* Hero image — 16:9 rounded-xl. Falls back to a warm gradient with
          the restaurant's initial when no profile photo exists. */}
      <div className="relative aspect-[16/9] rounded-xl overflow-hidden mb-3 bg-surface-muted">
        {heroImage ? (
          <Image
            src={heroImage}
            alt={restaurant.name}
            fill
            className="object-cover transition-transform duration-300 group-hover:scale-[1.02]"
            sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
          />
        ) : (
          <div className="absolute inset-0 bg-gradient-to-br from-brand-light via-brand-badge to-brand flex items-center justify-center">
            <span className="text-white text-5xl font-black tracking-tight drop-shadow-sm">
              {initial}
            </span>
          </div>
        )}

        {/* Open / closed pill — top-left, dot prefix, bilingual. */}
        <span className={`absolute top-3 left-3 text-xs font-semibold px-2.5 py-1 rounded-full ${
          restaurant.is_open
            ? 'bg-white/95 text-ink-primary'
            : 'bg-ink-primary/85 text-white backdrop-blur-sm'
        }`}>
          {restaurant.is_open ? '🟢 Ouvert / Open' : '🔴 Fermé / Closed'}
        </span>
      </div>

      {/* Body */}
      <div>
        <p className="font-bold text-ink-primary text-base leading-tight line-clamp-1">
          {restaurant.name}
        </p>

        {location && (
          <p className="text-sm text-ink-secondary mt-0.5 line-clamp-1">
            {location}
          </p>
        )}

        {cuisine && (
          <span className="inline-block mt-2 bg-brand-light text-brand-darker text-xs font-semibold px-2 py-0.5 rounded-full">
            {cuisine}
          </span>
        )}
      </div>
    </Link>
  )
}

// ─── Skeleton loader ─────────────────────────────────────────────────────────
function CardSkeleton() {
  return (
    <div>
      <div className="aspect-[16/9] skeleton rounded-xl mb-3" />
      <div className="skeleton h-4 w-3/4 mb-2" />
      <div className="skeleton h-3 w-1/2" />
    </div>
  )
}

// ─── Page ────────────────────────────────────────────────────────────────────
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

  // Hide the mobile floating "Join" for users who already own a restaurant
  // (or any admin). Same logic as <TopNav>.
  const [hideJoinCta, setHideJoinCta] = useState(false)
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const me = await (await fetch('/api/auth/me', { cache: 'no-store' })).json()
        if (cancelled || !me.user) return
        if (['super_admin', 'admin', 'moderator'].includes(me.user.role)) {
          setHideJoinCta(true); return
        }
        const v = await (await fetch('/api/vendor/restaurants', { cache: 'no-store' })).json()
        if (cancelled) return
        if ((v.restaurants ?? []).length > 0) setHideJoinCta(true)
      } catch { /* fail open: keep showing Join */ }
    })()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    async function fetchRestaurants() {
      const { data } = await supabase
        .from('restaurants')
        .select('*')
        .eq('is_active', true)
        .in('status', ['active', 'approved'])
        .is('deleted_at', null)
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
    <div className="min-h-screen bg-surface">

      <TopNav cta={{ label: t('nav.join'), href: '/join' }} />

      {/* Welcome banner — muted brand-light surface, not a shouting orange */}
      {!authLoading && !user && !bannerDismissed && (
        <div className="bg-brand-light text-brand-darker border-b border-divider">
          <div className="max-w-6xl mx-auto px-4 py-2.5 flex items-center justify-between gap-3">
            <Link href="/account" className="text-sm font-semibold flex-1 hover:underline">
              🎉 {t('banner.text')} — {t('banner.cta')}
            </Link>
            <button
              onClick={() => { setBannerDismissed(true); localStorage.setItem('banner_dismissed', '1') }}
              className="text-brand-darker/60 hover:text-brand-darker text-lg leading-none"
              aria-label="Fermer"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {/* City selector — pill row, selected city filled in black (Uber style) */}
      <div className="bg-surface border-b border-divider">
        <div className="max-w-6xl mx-auto px-4 py-3 flex gap-2 overflow-x-auto">
          {CITIES.map(city => {
            const active = selectedCity === city.name
            return (
              <button
                key={city.name}
                onClick={() => setSelectedCity(city.name)}
                className={`flex-shrink-0 px-4 py-1.5 rounded-full text-sm font-semibold whitespace-nowrap transition-colors ${
                  active
                    ? 'bg-ink-primary text-white'
                    : 'bg-surface-muted text-ink-secondary hover:text-ink-primary'
                }`}
              >
                {city.name}
              </button>
            )
          })}
        </div>
      </div>

      {/* Main grid */}
      <main className="max-w-6xl mx-auto px-4 py-6 pb-28">

        {!loading && filtered.length > 0 && (
          <h1 className="text-2xl sm:text-3xl font-bold text-ink-primary mb-1">
            Restaurants à {selectedCity}
          </h1>
        )}

        {!loading && filtered.length > 0 && (
          <p className="text-sm text-ink-secondary mb-6">
            <span className="font-semibold text-ink-primary">{filtered.length}</span>
            {' '}{t('list.count')}
            {openCount > 0 && (
              <> · <span className="text-brand-darker font-semibold">{openCount}</span> {t('list.openCount')}</>
            )}
          </p>
        )}

        {loading && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5 sm:gap-6">
            {Array.from({ length: 6 }).map((_, i) => <CardSkeleton key={i} />)}
          </div>
        )}

        {!loading && filtered.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5 sm:gap-6">
            {filtered.map(r => <RestaurantCard key={r.id} restaurant={r} />)}
          </div>
        )}

        {!loading && filtered.length === 0 && (
          <div className="flex flex-col items-center justify-center py-24 text-center px-4">
            <div className="w-20 h-20 bg-surface-muted rounded-full flex items-center justify-center text-4xl mb-5">
              🏪
            </div>
            <h2 className="text-xl font-bold text-ink-primary mb-2">{t('list.emptyTitle')}</h2>
            <p className="text-ink-secondary text-sm mb-1 max-w-xs">{t('list.emptySub')}</p>
            <p className="text-ink-tertiary text-xs mb-6">{selectedCity}</p>
            <Link
              href="/join"
              className="bg-brand hover:bg-brand-dark text-white px-6 py-3 rounded-full font-semibold text-sm transition-colors"
            >
              {t('list.joinBtn')}
            </Link>
          </div>
        )}

      </main>

      {/* Mobile "Join us" pill — discreet, bottom-left */}
      {!hideJoinCta && (
        <div className="sm:hidden fixed bottom-6 left-4 z-30">
          <Link
            href="/join"
            className="bg-surface border border-divider text-ink-primary text-sm font-semibold px-4 py-2.5 rounded-full shadow-card flex items-center gap-1.5"
          >
            {t('nav.join')}
          </Link>
        </div>
      )}

      {/* Floating Map button — primary brand */}
      <button
        onClick={() => setShowMap(true)}
        className="fixed bottom-6 right-4 z-30 bg-brand hover:bg-brand-dark text-white px-5 py-3 rounded-full shadow-card flex items-center gap-2 text-sm font-semibold transition-colors"
      >
        🗺️ {t('list.viewMap')}
      </button>

      {/* Map overlay */}
      {showMap && (
        <div className="fixed inset-0 z-50 flex flex-col bg-surface">
          <div className="h-14 flex-shrink-0 bg-surface border-b border-divider flex items-center justify-between px-4">
            <span className="font-semibold text-ink-primary text-sm">
              {t('list.mapIn')} {selectedCity}
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
              restaurants={filtered}
              onSelectRestaurant={handleMapSelect}
              selectedId={mapSelected?.id ?? null}
              center={cityData.center}
              zoom={cityData.zoom}
            />

            {mapSelected && (
              <>
                <div
                  className="absolute inset-0 bg-black/30 md:hidden"
                  onClick={() => setMapSelected(null)}
                />
                <div className="absolute bottom-0 left-0 right-0 z-10 md:top-0 md:right-auto md:w-80 bg-surface rounded-t-3xl md:rounded-none md:border-r md:border-divider shadow-2xl overflow-hidden">
                  <div className="md:hidden w-10 h-1 bg-divider rounded-full mx-auto mt-3 mb-1" />
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
