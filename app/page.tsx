'use client'

export const dynamic = 'force-dynamic'

import { useState, useEffect, useCallback, useMemo } from 'react'
import dynamicImport from 'next/dynamic'
import Link from 'next/link'
import Image from 'next/image'
import { supabase } from '@/lib/supabase'
import { Restaurant } from '@/types'
import RestaurantSidebar from '@/components/RestaurantSidebar'
import TopNav from '@/components/TopNav'
import RestaurantCard, { RestaurantCardSkeleton, type RatingSummary } from '@/components/RestaurantCard'
import { useLanguage, useBi } from '@/lib/languageContext'
import { formatPrepTime } from '@/lib/prepTime'
import { useAuth } from '@/lib/authContext'
import { useCity } from '@/lib/cityContext'
import { useDataMode } from '@/lib/dataMode'
import { arrangePromoted, FEED_INJECT_EVERY_RESTAURANT } from '@/lib/promotions'
import { CUISINE_CATEGORIES, matchesCuisineCategory } from '@/lib/cuisineCategories'

const Map = dynamicImport(() => import('@/components/Map'), { ssr: false })

// City → Mapbox center + zoom. Order matches the CITIES list in cityContext.
const CITY_CENTERS: Record<string, { center: [number, number]; zoom: number }> = {
  'Yaoundé': { center: [11.5021, 3.848],    zoom: 13 },
  'Abidjan': { center: [-4.0083, 5.36],      zoom: 13 },
  'Dakar':   { center: [-17.4441, 14.6937],  zoom: 13 },
  'Lomé':    { center: [1.2123, 6.1375],     zoom: 13 },
}

// "Under 30 min" pill threshold — a restaurant qualifies when the top of
// its advertised range is at or below this.
const QUICK_PREP_MAX = 30
// "Top rated" pill threshold.
const TOP_RATED_MIN = 4

type SortKey = 'default' | 'rating' | 'prep' | 'distance'

// Great-circle distance in km. Only used to order the feed, so the
// spherical approximation is plenty.
function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371
  const dLat = (b.lat - a.lat) * Math.PI / 180
  const dLng = (b.lng - a.lng) * Math.PI / 180
  const la1 = a.lat * Math.PI / 180
  const la2 = b.lat * Math.PI / 180
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

export default function HomePage() {
  const bi = useBi()
  const [restaurants, setRestaurants] = useState<Restaurant[]>([])
  const [ratingSummary, setRatingSummary] = useState<Record<string, RatingSummary>>({})
  const [openStatus, setOpenStatus] = useState<Record<string, { open: boolean }>>({})
  const [loading, setLoading] = useState(true)
  const [showMap, setShowMap] = useState(false)
  const [mapSelected, setMapSelected] = useState<Restaurant | null>(null)
  const [bannerDismissed, setBannerDismissed] = useState(true)
  const [query, setQuery] = useState('')
  const [pendingOrders, setPendingOrders] = useState(0)
  const { t, locale } = useLanguage()
  const { user, loading: authLoading } = useAuth()
  const { city } = useCity()

  // ── Mobile filter state ────────────────────────────────────────────────
  // All of it is rendered inside md:hidden blocks, so a desktop viewer
  // never changes these and the desktop feed keeps its original ordering.
  const [cuisine, setCuisine]     = useState<string | null>(null)
  const [openOnly, setOpenOnly]   = useState(false)
  const [promoOnly, setPromoOnly] = useState(false)
  const [topRated, setTopRated]   = useState(false)
  const [quickPrep, setQuickPrep] = useState(false)
  const [sort, setSort]           = useState<SortKey>('default')
  // Set once the browser hands us a position; only requested when the
  // user actually picks the distance sort.
  const [userPos, setUserPos] = useState<{ lat: number; lng: number } | null>(null)
  const [geoDenied, setGeoDenied] = useState(false)

  // `/` is the public landing page for everyone — logged out, customers,
  // and vendors alike. Vendors reach their dashboard via the explicit
  // "Mon restaurant" link in the nav, never via an automatic redirect.

  // Pending-orders banner for vendors browsing the home page. Populated
  // lazily so the home feed renders fast — the banner only shows when there
  // is something to see.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const pRes = await fetch('/api/vendor/pending-count', { cache: 'no-store' })
        const p = await pRes.json()
        if (!cancelled) setPendingOrders(Number(p?.count ?? 0))
      } catch { /* transient failure — no banner */ }
    })()
    return () => { cancelled = true }
  }, [])

  // Active restaurant promotions for the current city. Re-fetched
  // whenever the city changes so the user always sees promos relevant
  // to where they're browsing. Shape: { id, target_id, placement }.
  const [activePromos, setActivePromos] = useState<Array<{ id: string; target_id: string; placement: 'top_list' | 'feed_card' | 'banner' }>>([])
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(`/api/promotions/active?city=${encodeURIComponent(city)}&type=restaurant`, { cache: 'no-store' })
        const d = await res.json()
        if (!cancelled && Array.isArray(d?.promotions)) {
          setActivePromos(d.promotions.map((p: { id: string; target_id: string; placement: 'top_list' | 'feed_card' | 'banner' }) => ({
            id: p.id, target_id: p.target_id, placement: p.placement,
          })))
        }
      } catch { /* feed renders un-promoted on failure */ }
    })()
    return () => { cancelled = true }
  }, [city])

  // Restaurants that currently have a live voucher — backs the 💰 Promo
  // pill. Empty set on failure, which just makes the pill match nothing.
  const [promoRestaurantIds, setPromoRestaurantIds] = useState<Set<string>>(new Set())
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(`/api/restaurants/promos?city=${encodeURIComponent(city)}`, { cache: 'no-store' })
        const d = await res.json()
        if (!cancelled && Array.isArray(d?.restaurantIds)) {
          setPromoRestaurantIds(new Set<string>(d.restaurantIds))
        }
      } catch { /* pill matches nothing */ }
    })()
    return () => { cancelled = true }
  }, [city])

  // "Order again" — restaurant ids the signed-in customer has ordered from,
  // most recent first. Guests and vendors get an empty list (the endpoint
  // returns [] for non-customers), so the row simply doesn't render.
  const [reorderIds, setReorderIds] = useState<string[]>([])
  useEffect(() => {
    if (authLoading || !user) { setReorderIds([]); return }
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/customer/orders', { cache: 'no-store' })
        const d = await res.json()
        if (cancelled || !Array.isArray(d?.orders)) return
        const seen = new Set<string>()
        const ids: string[] = []
        for (const o of d.orders as Array<{ restaurant_id?: string }>) {
          if (o.restaurant_id && !seen.has(o.restaurant_id)) {
            seen.add(o.restaurant_id)
            ids.push(o.restaurant_id)
          }
        }
        setReorderIds(ids)
      } catch { /* no row */ }
    })()
    return () => { cancelled = true }
  }, [user, authLoading])

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

  // Map toggle now lives in TopNav (desktop only); it dispatches this
  // event on click.
  useEffect(() => {
    const onToggle = () => setShowMap(prev => !prev)
    window.addEventListener('nt-toggle-map', onToggle)
    return () => window.removeEventListener('nt-toggle-map', onToggle)
  }, [])

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
        .in('status', ['active', 'approved'])
        .is('deleted_at', null)
        .order('created_at', { ascending: false })
      if (data) setRestaurants(data)
      setLoading(false)

      // Rating + open-status summaries are follow-ups so the cards paint
      // first. Both failures are silent — cards just fall back to the
      // legacy state (is_open column, no rating line).
      if (data && data.length > 0) {
        const ids = data.map(r => r.id).join(',')
        try {
          const [ratingRes, statusRes] = await Promise.all([
            fetch(`/api/restaurants/ratings-summary?ids=${ids}`, { cache: 'no-store' }).then(r => r.json()),
            fetch(`/api/restaurants/open-status?ids=${ids}`,     { cache: 'no-store' }).then(r => r.json()),
          ])
          if (ratingRes?.summary && typeof ratingRes.summary === 'object') setRatingSummary(ratingRes.summary)
          if (statusRes?.status && typeof statusRes.status === 'object') setOpenStatus(statusRes.status)
        } catch { /* falls back to is_open / no rating line */ }
      }
    }
    fetchRestaurants()
  }, [])

  // Distance sort needs a position. We only ask when the user picks it,
  // so the permission prompt is always explained by an action they just
  // took. A denial falls back to the default order.
  const chooseSort = useCallback((next: SortKey) => {
    setSort(next)
    if (next !== 'distance' || userPos || typeof navigator === 'undefined' || !navigator.geolocation) return
    navigator.geolocation.getCurrentPosition(
      pos => { setUserPos({ lat: pos.coords.latitude, lng: pos.coords.longitude }); setGeoDenied(false) },
      () => setGeoDenied(true),
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 5 * 60_000 },
    )
  }, [userPos])

  const handleMapSelect = useCallback((m: { id: string }) => {
    setMapSelected(restaurants.find(r => r.id === m.id) ?? null)
  }, [restaurants])

  const cityData = CITY_CENTERS[city] ?? CITY_CENTERS['Yaoundé']

  const isOpenNow = useCallback(
    // Prefer computed status; only fall through to is_open while the
    // bulk endpoint is still loading.
    (r: Restaurant) => openStatus[r.id]?.open ?? r.is_open,
    [openStatus],
  )

  const filtered = useMemo(() => {
    const list = restaurants
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
      .filter(r => (cuisine ? matchesCuisineCategory(r, cuisine) : true))
      .filter(r => (openOnly ? isOpenNow(r) : true))
      .filter(r => (promoOnly ? promoRestaurantIds.has(r.id) : true))
      .filter(r => {
        if (!topRated) return true
        const s = ratingSummary[r.id]
        return !!s && s.count > 0 && s.average >= TOP_RATED_MIN
      })
      .filter(r => {
        if (!quickPrep) return true
        return r.prep_time_max != null && r.prep_time_max <= QUICK_PREP_MAX
      })

    if (sort === 'rating') {
      return [...list].sort((a, b) =>
        (ratingSummary[b.id]?.average ?? 0) - (ratingSummary[a.id]?.average ?? 0))
    }
    if (sort === 'prep') {
      // Restaurants with no advertised range sink to the bottom rather
      // than pretending to be instant.
      const key = (r: Restaurant) => r.prep_time_max ?? Number.POSITIVE_INFINITY
      return [...list].sort((a, b) => key(a) - key(b))
    }
    if (sort === 'distance' && userPos) {
      const key = (r: Restaurant) =>
        (Number.isFinite(r.lat) && Number.isFinite(r.lng))
          ? distanceKm(userPos, r)
          : Number.POSITIVE_INFINITY
      return [...list].sort((a, b) => key(a) - key(b))
    }
    return list
  }, [restaurants, city, query, cuisine, openOnly, promoOnly, topRated, quickPrep,
      sort, userPos, ratingSummary, promoRestaurantIds, isOpenNow])

  // Computed open-count for the header line.
  const openCount = filtered.filter(isOpenNow).length

  const anyFilterOn = !!cuisine || openOnly || promoOnly || topRated || quickPrep || sort !== 'default' || !!query.trim()
  const clearFilters = () => {
    setCuisine(null); setOpenOnly(false); setPromoOnly(false)
    setTopRated(false); setQuickPrep(false); setSort('default')
    setQuery('')
    if (typeof window !== 'undefined' && window.location.search) {
      window.history.replaceState(null, '', window.location.pathname)
    }
  }

  // Merge active promotions into the filtered list. arrangePromoted
  // pins top_list promos at the front and injects feed_card promos
  // every 5th position, capped at MAX_PROMOS_PER_PAGE.
  // Plain record (not `new Map(...)`) because the `Map` identifier in
  // this file is already taken by the dynamic Mapbox component import.
  const restaurantById: Record<string, Restaurant> = {}
  for (const r of restaurants) restaurantById[r.id] = r
  const arranged = arrangePromoted(
    filtered,
    activePromos,
    (id) => restaurantById[id] ?? null,
    (r) => r.id,
    FEED_INJECT_EVERY_RESTAURANT,
  )

  // "Order again" cards — resolved against the loaded feed and scoped to
  // the selected city so the row stays consistent with everything else
  // on the page.
  const reorderRestaurants = reorderIds
    .map(id => restaurantById[id])
    .filter((r): r is Restaurant => !!r && r.city === city)
    .slice(0, 10)

  return (
    <div className="min-h-screen bg-surface">

      <TopNav cta={{ label: t('nav.join'), href: '/join' }} />

      {/* Pending-orders banner for vendors browsing the home page. Tap
          to go straight to the dashboard. Hidden when there's nothing
          pending. */}
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

      {/* ══ MOBILE ONLY: cuisine icon rail ═════════════════════════════════
          Horizontal scroll, no wrap. Tapping toggles a single-select
          filter; tapping the active one clears it. */}
      <div className="md:hidden border-b border-divider">
        <div
          className="flex gap-4 overflow-x-auto px-4 py-3 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          role="group"
          aria-label={bi('Types de cuisine', 'Cuisine types')}
        >
          {CUISINE_CATEGORIES.map(cat => {
            const active = cuisine === cat.id
            return (
              <button
                key={cat.id}
                type="button"
                aria-pressed={active}
                onClick={() => setCuisine(active ? null : cat.id)}
                className="flex flex-col items-center gap-1.5 flex-shrink-0 w-[60px]"
              >
                <span
                  aria-hidden="true"
                  className={`w-14 h-14 rounded-2xl flex items-center justify-center text-2xl transition-colors ${
                    active
                      ? 'bg-brand text-white ring-2 ring-brand ring-offset-2 ring-offset-surface'
                      : 'bg-surface-muted'
                  }`}
                >
                  {cat.icon}
                </span>
                <span className={`text-[11px] leading-tight text-center truncate w-full ${
                  active ? 'text-brand font-semibold' : 'text-ink-secondary'
                }`}>
                  {locale === 'en' ? cat.en : cat.fr}
                </span>
              </button>
            )
          })}
        </div>
      </div>

      {/* ══ MOBILE ONLY: filter pills + sort ══════════════════════════════ */}
      <div className="md:hidden border-b border-divider">
        <div className="flex gap-2 overflow-x-auto px-4 py-2.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <SortPill value={sort} onChange={chooseSort} />
          <FilterPill active={openOnly}  onClick={() => setOpenOnly(v => !v)}>
            🟢 {bi('Ouvert', 'Open now')}
          </FilterPill>
          <FilterPill active={promoOnly} onClick={() => setPromoOnly(v => !v)}>
            💰 {bi('Promo', 'Deals')}
          </FilterPill>
          <FilterPill active={topRated}  onClick={() => setTopRated(v => !v)}>
            ⭐ {bi('Mieux notés', 'Top rated')}
          </FilterPill>
          <FilterPill active={quickPrep} onClick={() => setQuickPrep(v => !v)}>
            🕐 {bi('Moins de 30 min', 'Under 30 min')}
          </FilterPill>
        </div>

        {/* Active free-text query — mobile has no visible search field
            (it lives in the BottomNav overlay), so a deep link or a
            desktop-seeded ?q= needs somewhere to show itself. */}
        {query.trim() && (
          <div className="px-4 pb-2.5">
            <button
              onClick={() => {
                setQuery('')
                if (typeof window !== 'undefined' && window.location.search) {
                  window.history.replaceState(null, '', window.location.pathname)
                }
              }}
              className="inline-flex items-center gap-1.5 bg-ink-primary text-white text-xs font-semibold px-3 py-1.5 rounded-full"
            >
              🔍 {query.trim()} <span aria-hidden="true">✕</span>
            </button>
          </div>
        )}

        {sort === 'distance' && geoDenied && (
          <p className="px-4 pb-2.5 text-xs text-ink-tertiary">
            {bi('Position indisponible — tri par défaut.', 'Location unavailable — showing the default order.')}
          </p>
        )}
      </div>

      {/* Main grid */}
      <main className="max-w-6xl mx-auto px-4 pt-4 pb-28">

        {/* ══ MOBILE ONLY: Order again ══════════════════════════════════ */}
        {!loading && reorderRestaurants.length > 0 && !anyFilterOn && (
          <section className="md:hidden mb-6">
            <h2 className="text-lg font-bold text-ink-primary mb-3">
              {bi('Commander à nouveau', 'Order again')}
            </h2>
            <div className="flex gap-3 overflow-x-auto -mx-4 px-4 pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {reorderRestaurants.map(r => (
                <ReorderCard key={r.id} restaurant={r} />
              ))}
            </div>
          </section>
        )}

        {!loading && filtered.length > 0 && (
          <>
            <h1 className="hidden md:block text-2xl sm:text-3xl font-bold text-ink-primary mb-1">
              {t('list.mapIn')} {city}
            </h1>
            <p className="hidden md:block text-sm text-ink-secondary mb-6">
              <span className="font-semibold text-ink-primary">{filtered.length}</span>
              {' '}{t('list.count')}
              {openCount > 0 && (
                <> · <span className="text-brand-darker font-semibold">{openCount}</span> {t('list.openCount')}</>
              )}
            </p>
            {/* Compact mobile equivalent — no oversized page title; the
                header already says which city you're in. */}
            <p className="md:hidden text-xs text-ink-secondary mb-3">
              <span className="font-semibold text-ink-primary">{filtered.length}</span>
              {' '}{t('list.count')}
              {openCount > 0 && (
                <> · <span className="text-brand-darker font-semibold">{openCount}</span> {t('list.openCount')}</>
              )}
            </p>
          </>
        )}

        {loading && (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-2 md:gap-6 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => <RestaurantCardSkeleton key={i} />)}
          </div>
        )}

        {!loading && filtered.length > 0 && (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-2 md:gap-6 lg:grid-cols-3">
            {arranged.map((entry, idx) => (
              <RestaurantCard
                key={`${entry.item.id}-${entry.promotionId ?? 'reg'}-${idx}`}
                restaurant={entry.item}
                rating={ratingSummary[entry.item.id]}
                openOverride={openStatus[entry.item.id]?.open}
                promotionId={entry.promotionId}
              />
            ))}
          </div>
        )}

        {!loading && filtered.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-center px-4">
            <div className="w-20 h-20 bg-surface-muted rounded-full flex items-center justify-center text-4xl mb-5">
              {anyFilterOn ? '🔍' : '🏪'}
            </div>
            <h2 className="text-xl font-bold text-ink-primary mb-2">
              {anyFilterOn ? bi('Aucun résultat', 'No matches') : t('list.emptyTitle')}
            </h2>
            <p className="text-ink-secondary text-sm mb-1 max-w-xs">
              {anyFilterOn
                ? bi('Essayez d\'élargir vos filtres', 'Try widening your filters')
                : t('list.emptySub')}
            </p>
            <p className="text-ink-tertiary text-xs mb-6">{city}</p>
            {anyFilterOn ? (
              <button
                onClick={clearFilters}
                className="bg-brand hover:bg-brand-dark text-white px-6 py-3 rounded-full font-semibold text-sm transition-colors"
              >
                {bi('Réinitialiser les filtres', 'Reset filters')}
              </button>
            ) : (
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

      {/* Map overlay — desktop only now. The TopNav map button that opens
          it is hidden below md, so `showMap` never flips on mobile. */}
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
              // Override each marker's is_open with the computed status when
              // available so manual override / timezone-correct schedule
              // colour the pins. Falls back to restaurants.is_open during
              // the brief window before the bulk endpoint resolves.
              restaurants={filtered.map(r => ({
                ...r,
                is_open: openStatus[r.id]?.open ?? r.is_open,
              }))}
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
                      openOverride={openStatus[mapSelected.id]?.open}
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

// ─── Mobile filter pill ──────────────────────────────────────────────────────
function FilterPill({
  active, onClick, children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex-shrink-0 text-xs font-semibold px-3.5 py-2 rounded-full border whitespace-nowrap transition-colors ${
        active
          ? 'bg-ink-primary text-white border-ink-primary'
          : 'bg-surface text-ink-secondary border-divider'
      }`}
    >
      {children}
    </button>
  )
}

// ─── Mobile sort pill ────────────────────────────────────────────────────────
// A native <select> dressed as a pill: it gets the platform picker sheet
// for free, which is exactly the interaction a native app would use.
function SortPill({ value, onChange }: { value: SortKey; onChange: (v: SortKey) => void }) {
  const bi = useBi()
  const active = value !== 'default'
  const label =
    value === 'rating'   ? bi('Note', 'Rating')
    : value === 'prep'   ? bi('Rapidité', 'Prep time')
    : value === 'distance' ? bi('Distance', 'Distance')
    : bi('Trier', 'Sort')

  return (
    <div className={`relative flex-shrink-0 rounded-full border transition-colors ${
      active ? 'bg-ink-primary border-ink-primary' : 'bg-surface border-divider'
    }`}>
      {/* The span sizes the pill and is the only thing drawn; the select
          sits on top at zero opacity so the tap opens the platform's own
          picker sheet — the interaction a native app would use. */}
      <span
        aria-hidden="true"
        className={`block text-xs font-semibold px-3.5 py-2 whitespace-nowrap ${
          active ? 'text-white' : 'text-ink-secondary'
        }`}
      >
        ⇅ {label} ▾
      </span>
      <select
        value={value}
        onChange={e => onChange(e.target.value as SortKey)}
        aria-label={bi('Trier par', 'Sort by')}
        className="absolute inset-0 w-full h-full opacity-0 appearance-none cursor-pointer"
      >
        <option value="default">{bi('Par défaut', 'Default')}</option>
        <option value="rating">{bi('Mieux notés', 'Rating')}</option>
        <option value="prep">{bi('Préparation la plus rapide', 'Fastest prep time')}</option>
        <option value="distance">{bi('Le plus proche', 'Nearest')}</option>
      </select>
    </div>
  )
}

// ─── "Order again" mini card ─────────────────────────────────────────────────
function ReorderCard({ restaurant }: { restaurant: Restaurant }) {
  const { isLowData } = useDataMode()
  const [imgError, setImgError] = useState(false)
  const heroImage = restaurant.image_url || restaurant.logo_url
  const showImage = !isLowData && heroImage && !imgError
  const prepLabel = formatPrepTime(restaurant.prep_time_min, restaurant.prep_time_max)
  const initial = (restaurant.name?.[0] ?? '?').toUpperCase()

  return (
    <Link href={`/restaurant/${restaurant.id}`} className="flex-shrink-0 w-32">
      <div className="relative w-32 h-20 rounded-xl overflow-hidden bg-surface-muted">
        {showImage ? (
          <Image
            src={heroImage!}
            alt={restaurant.name}
            fill
            sizes="128px"
            onError={() => setImgError(true)}
            className="object-cover"
          />
        ) : (
          <div className="absolute inset-0 bg-gradient-to-br from-brand-light via-brand-badge to-brand flex items-center justify-center">
            <span className="text-white text-2xl font-black drop-shadow-sm">{initial}</span>
          </div>
        )}
      </div>
      <p className="mt-1.5 text-xs font-bold text-ink-primary truncate">{restaurant.name}</p>
      {prepLabel && <p className="text-[11px] text-ink-secondary truncate">🕐 {prepLabel}</p>}
    </Link>
  )
}
