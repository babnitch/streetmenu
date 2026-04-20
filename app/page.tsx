'use client'

export const dynamic = 'force-dynamic'

import { useState, useEffect, useCallback, useRef } from 'react'
import dynamicImport from 'next/dynamic'
import Link from 'next/link'
import Image from 'next/image'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { Restaurant } from '@/types'
import RestaurantSidebar from '@/components/RestaurantSidebar'
import TopNav from '@/components/TopNav'
import { useLanguage, useBi } from '@/lib/languageContext'
import { useAuth } from '@/lib/authContext'
import { useCity } from '@/lib/cityContext'

const Map = dynamicImport(() => import('@/components/Map'), { ssr: false })

// City → Mapbox center + zoom. Order matches the CITIES list in cityContext.
const CITY_CENTERS: Record<string, { center: [number, number]; zoom: number }> = {
  'Yaoundé': { center: [11.5021, 3.848],    zoom: 13 },
  'Abidjan': { center: [-4.0083, 5.36],      zoom: 13 },
  'Dakar':   { center: [-17.4441, 14.6937],  zoom: 13 },
  'Lomé':    { center: [1.2123, 6.1375],     zoom: 13 },
}

// ─── Restaurant card ─────────────────────────────────────────────────────────
function RestaurantCard({
  restaurant,
}: {
  restaurant: Restaurant
}) {
  const bi = useBi()
  const neighborhood = restaurant.neighborhood || restaurant.address
  const location = [neighborhood, restaurant.city].filter(Boolean).join(', ')
  const cuisine = restaurant.cuisine_type || restaurant.description
  const initial = (restaurant.name?.[0] ?? '?').toUpperCase()
  const heroImage = restaurant.image_url || restaurant.logo_url

  return (
    <Link
      href={`/restaurant/${restaurant.id}`}
      className="group block bg-surface border border-divider rounded-xl overflow-hidden hover:shadow-card transition-shadow"
    >
      <div className="relative aspect-[16/9] overflow-hidden bg-surface-muted">
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
      </div>

      <div className="p-3 flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="font-bold text-brand-dark text-base leading-tight line-clamp-1">
            {restaurant.name}
          </p>
          {location && (
            <p className="text-sm text-brand-dark mt-0.5 line-clamp-1">
              {location}
            </p>
          )}
          {cuisine && (
            <span className="inline-block mt-2 bg-brand-light text-brand-darker text-xs font-semibold px-2 py-0.5 rounded-full border border-brand-badge/60">
              {cuisine}
            </span>
          )}
        </div>
        <span className={`flex-shrink-0 text-xs font-semibold whitespace-nowrap ${
          restaurant.is_open ? 'text-brand-darker' : 'text-danger'
        }`}>
          {restaurant.is_open ? bi('● Ouvert', '● Open') : bi('● Fermé', '● Closed')}
        </span>
      </div>
    </Link>
  )
}

function CardSkeleton() {
  return (
    <div className="bg-surface border border-divider rounded-xl overflow-hidden">
      <div className="aspect-[16/9] skeleton rounded-none" />
      <div className="p-3 space-y-2">
        <div className="skeleton h-4 w-3/4" />
        <div className="skeleton h-3 w-1/2" />
      </div>
    </div>
  )
}

export default function HomePage() {
  const bi = useBi()
  const router = useRouter()
  const [restaurants, setRestaurants] = useState<Restaurant[]>([])
  const [loading, setLoading] = useState(true)
  const [showMap, setShowMap] = useState(false)
  const [mapSelected, setMapSelected] = useState<Restaurant | null>(null)
  const [bannerDismissed, setBannerDismissed] = useState(true)
  const [query, setQuery] = useState('')
  const [pendingOrders, setPendingOrders] = useState(0)
  const [redirecting, setRedirecting] = useState(false)
  const { t } = useLanguage()
  const { user, loading: authLoading } = useAuth()
  const { city } = useCity()
  const searchRef = useRef<HTMLInputElement>(null)

  // Vendor auto-redirect + pending-orders banner.
  //
  // - On a fresh app open (no nt_hasVisitedHome flag in sessionStorage),
  //   an approved vendor lands on /dashboard instead of the home page.
  //   Pending-only vendors (all restaurants still awaiting approval)
  //   stay on / — they have nothing to manage yet.
  // - Once the flag is set, subsequent visits to / (e.g. tapping the
  //   Home tab from the dashboard) don't redirect. The user explicitly
  //   asked for the home feed.
  // - Whether or not the redirect fires, we populate pendingOrders so
  //   a vendor who returns to / can see the banner CTA.
  useEffect(() => {
    let cancelled = false
    const hasVisited = typeof window !== 'undefined'
      ? sessionStorage.getItem('nt_hasVisitedHome') === '1'
      : false
    // Mark visited synchronously — subsequent mounts in the same session
    // skip the redirect regardless of whether the async probe has finished.
    try { sessionStorage.setItem('nt_hasVisitedHome', '1') } catch {}

    ;(async () => {
      try {
        const meRes = await fetch('/api/auth/me', { cache: 'no-store' })
        const me = await meRes.json()
        if (cancelled) return
        if (!me?.user) return
        if (['super_admin', 'admin', 'moderator'].includes(me.user.role)) return

        const vRes = await fetch('/api/vendor/restaurants', { cache: 'no-store' })
        const v = await vRes.json()
        if (cancelled) return
        const list: Array<{ status?: string }> = v.restaurants ?? []
        const hasApproved = list.some(r => r.status && r.status !== 'pending')
        if (!hasApproved) return

        if (!hasVisited) {
          setRedirecting(true)
          router.replace('/dashboard')
          return
        }

        // User explicitly came back to home — show the pending banner.
        const pRes = await fetch('/api/vendor/pending-count', { cache: 'no-store' })
        const p = await pRes.json()
        if (!cancelled) setPendingOrders(Number(p?.count ?? 0))
      } catch { /* fail open: just show the home feed */ }
    })()
    return () => { cancelled = true }
  }, [router])

  // TopNav desktop search submits to /?q=...#search. Seed the local query
  // from the URL on mount + whenever history changes. Client-only reads
  // keep this out of Next's static-prerender path (no Suspense boundary
  // needed as we'd get with useSearchParams).
  useEffect(() => {
    if (typeof window === 'undefined') return
    const read = () => setQuery(new URLSearchParams(window.location.search).get('q') ?? '')
    read()
    window.addEventListener('popstate', read)
    return () => window.removeEventListener('popstate', read)
  }, [])

  // Map toggle now lives in TopNav; it dispatches this event on click.
  useEffect(() => {
    const onToggle = () => setShowMap(prev => !prev)
    window.addEventListener('nt-toggle-map', onToggle)
    return () => window.removeEventListener('nt-toggle-map', onToggle)
  }, [])

  useEffect(() => {
    const dismissed = localStorage.getItem('banner_dismissed')
    if (!dismissed) setBannerDismissed(false)
  }, [])

  // #search hash (from BottomNav search tab) focuses the search input.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const handle = () => {
      if (window.location.hash === '#search' && searchRef.current) {
        searchRef.current.focus()
        searchRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }
    }
    handle()
    window.addEventListener('hashchange', handle)
    return () => window.removeEventListener('hashchange', handle)
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

  const handleMapSelect = useCallback((m: { id: string }) => {
    setMapSelected(restaurants.find(r => r.id === m.id) ?? null)
  }, [restaurants])

  const cityData = CITY_CENTERS[city] ?? CITY_CENTERS['Yaoundé']
  const filtered = restaurants
    .filter(r => r.city === city)
    .filter(r => {
      if (!query.trim()) return true
      const q = query.trim().toLowerCase()
      return (
        r.name.toLowerCase().includes(q) ||
        (r.cuisine_type?.toLowerCase().includes(q) ?? false) ||
        (r.neighborhood?.toLowerCase().includes(q) ?? false)
      )
    })
  const openCount = filtered.filter(r => r.is_open).length

  // While redirecting, render a minimal shell so we don't briefly flash
  // the home feed to an approved vendor.
  if (redirecting) {
    return (
      <div className="min-h-[calc(100dvh-4rem)] md:min-h-screen bg-surface flex items-center justify-center">
        <div className="skeleton h-6 w-40" />
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-surface">

      <TopNav cta={{ label: t('nav.join'), href: '/join' }} />

      {/* Pending-orders banner for vendors who returned to the home page
          after their initial redirect. Tap to go straight to the
          dashboard. Hidden when there's nothing pending. */}
      {pendingOrders > 0 && (
        <Link
          href="/dashboard"
          className="block bg-brand text-white border-b border-brand-dark hover:bg-brand-dark transition-colors"
        >
          <div className="max-w-6xl mx-auto px-4 py-2.5 flex items-center justify-between gap-3">
            <span className="text-sm font-semibold">
              🔔 {bi(`Vous avez ${pendingOrders} commande${pendingOrders > 1 ? 's' : ''} en attente`, `You have ${pendingOrders} pending order${pendingOrders > 1 ? 's' : ''}`)}
            </span>
            <span aria-hidden="true" className="text-sm font-semibold">→</span>
          </div>
        </Link>
      )}

      {/* Welcome banner */}
      {!authLoading && !user && !bannerDismissed && (
        <div className="bg-brand-light text-brand-darker border-b border-divider">
          <div className="max-w-6xl mx-auto px-4 py-2.5 flex items-center justify-between gap-3">
            <Link href="/account" className="text-sm font-semibold flex-1 hover:underline">
              🎉 {t('banner.text')} — {t('banner.cta')}
            </Link>
            <button
              onClick={() => { setBannerDismissed(true); localStorage.setItem('banner_dismissed', '1') }}
              className="text-brand-darker/60 hover:text-brand-darker text-lg leading-none"
              aria-label={bi('Fermer', 'Close')}
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {/* Search bar — mobile only. Desktop uses the inline TopNav search. */}
      <div id="search" className="bg-surface md:hidden">
        <div className="max-w-6xl mx-auto px-4 pt-4 pb-2">
          <label className="relative block">
            <span className="absolute inset-y-0 left-3 flex items-center text-ink-tertiary pointer-events-none">🔍</span>
            <input
              ref={searchRef}
              type="search"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder={bi('Rechercher un restaurant...', 'Search restaurants...')}
              className="w-full bg-surface-muted border border-transparent focus:border-brand focus:bg-surface rounded-full pl-9 pr-4 py-3 text-sm text-ink-primary placeholder-ink-tertiary outline-none transition-colors"
            />
          </label>
        </div>
      </div>

      {/* Main grid */}
      <main className="max-w-6xl mx-auto px-4 pt-4 pb-28">

        {!loading && filtered.length > 0 && (
          <>
            <h1 className="text-2xl sm:text-3xl font-bold text-ink-primary mb-1">
              {t('list.mapIn')} {city}
            </h1>
            <p className="text-sm text-ink-secondary mb-6">
              <span className="font-semibold text-ink-primary">{filtered.length}</span>
              {' '}{t('list.count')}
              {openCount > 0 && (
                <> · <span className="text-brand-darker font-semibold">{openCount}</span> {t('list.openCount')}</>
              )}
            </p>
          </>
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
          <div className="flex flex-col items-center justify-center py-20 text-center px-4">
            <div className="w-20 h-20 bg-surface-muted rounded-full flex items-center justify-center text-4xl mb-5">
              {query ? '🔍' : '🏪'}
            </div>
            <h2 className="text-xl font-bold text-ink-primary mb-2">
              {query ? bi('Aucun résultat', 'No matches') : t('list.emptyTitle')}
            </h2>
            <p className="text-ink-secondary text-sm mb-1 max-w-xs">
              {query
                ? bi('Essayez un autre terme', 'Try another term')
                : t('list.emptySub')}
            </p>
            <p className="text-ink-tertiary text-xs mb-6">{city}</p>
            {!query && (
              <Link
                href="/join"
                className="bg-brand hover:bg-brand-dark text-white px-6 py-3 rounded-full font-semibold text-sm transition-colors"
              >
                {t('list.joinBtn')}
              </Link>
            )}
          </div>
        )}

      </main>

      {/* Map toggle moved into TopNav (next to the city dropdown). The
          overlay below still opens when showMap flips — triggered by the
          nt-toggle-map custom event dispatched from the TopNav button. */}

      {/* Map overlay */}
      {showMap && (
        <div className="fixed inset-0 z-50 flex flex-col bg-surface">
          <div className="h-14 flex-shrink-0 bg-surface border-b border-divider flex items-center justify-between px-4">
            <span className="font-semibold text-ink-primary text-sm">
              {t('list.mapIn')} {city}
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
