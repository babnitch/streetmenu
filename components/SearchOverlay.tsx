'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { Restaurant } from '@/types'
import { useBi } from '@/lib/languageContext'
import { useCity } from '@/lib/cityContext'
import RestaurantCard, { RestaurantCardSkeleton, type RatingSummary } from './RestaurantCard'
import { normalizeCuisine } from '@/lib/cuisineCategories'
import Link from 'next/link'
import { useDishHits } from '@/lib/dishSearch'
import { useLanguage } from '@/lib/languageContext'
import { isPastEvent, formatEventWhen, EVENT_DATE_COLUMNS, type EventWhen } from '@/lib/eventDate'

interface SearchEvent extends EventWhen { id: string; title: string; category: string | null; venue: string | null; neighborhood: string | null; description: string | null }

// Full-screen search, opened from the home page's big search field (mobile
// and desktop: `desktop`). Since N1 the home page is its only user.
//
// Searches five things at once:
//   1. restaurant names       — local, over the city's restaurant list
//   2. cuisines               — same list, cuisine_type + description
//   3. neighborhoods          — same list, neighborhood + address
//   4. menu items             — a debounced `menu_items` query; a hit
//                               surfaces the restaurant that serves it,
//                               labelled with the matching dish
//   5. events                 — the city's upcoming events (title,
//                               category, venue, neighbourhood, description)
//
// Recent queries live in localStorage (most-recent-first, capped) so the
// overlay feels like a native app's search tab across sessions.

const RECENTS_KEY = 'tn_recent_searches'
const RECENTS_MAX = 8

function readRecents(): string[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter(x => typeof x === 'string').slice(0, RECENTS_MAX) : []
  } catch { return [] }
}

function writeRecents(list: string[]) {
  try { localStorage.setItem(RECENTS_KEY, JSON.stringify(list.slice(0, RECENTS_MAX))) } catch {}
}

export default function SearchOverlay({ open, onClose, desktop = false }: { open: boolean; onClose: () => void; desktop?: boolean }) {
  const bi = useBi()
  const { locale } = useLanguage()
  const [events, setEvents] = useState<SearchEvent[]>([])
  const { city } = useCity()
  const inputRef = useRef<HTMLInputElement>(null)

  const [query, setQuery]             = useState('')
  const [recents, setRecents]         = useState<string[]>([])
  const [restaurants, setRestaurants] = useState<Restaurant[]>([])
  const [ratings, setRatings]         = useState<Record<string, RatingSummary>>({})
  const [openStatus, setOpenStatus]   = useState<Record<string, { open: boolean }>>({})
  const [loading, setLoading]         = useState(false)

  // Auto-focus on open. The timeout lets the element mount + the sheet
  // paint first; focusing synchronously loses the keyboard on iOS.
  useEffect(() => {
    if (!open) return
    setRecents(readRecents())
    const t = setTimeout(() => inputRef.current?.focus(), 60)
    return () => clearTimeout(t)
  }, [open])

  // Escape closes; body scroll is locked while the overlay is up so the
  // page underneath doesn't drift.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [open, onClose])

  // Load the city's restaurants the first time the overlay opens (and
  // again whenever the city changes) — same filter set as the home feed.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    ;(async () => {
      setLoading(true)
      const { data } = await supabase
        .from('restaurants')
        .select('*')
        .eq('is_active', true)
        .in('status', ['active', 'approved'])
        .is('deleted_at', null)
        .eq('city', city)
        .order('created_at', { ascending: false })
      if (cancelled) return
      const list = (data ?? []) as Restaurant[]
      setRestaurants(list)
      setLoading(false)

      // Rating + open-status follow-ups, same as the home feed. Silent on
      // failure — the cards fall back to is_open and no rating line.
      if (list.length) {
        const ids = list.map(r => r.id).join(',')
        try {
          const [ratingRes, statusRes] = await Promise.all([
            fetch(`/api/restaurants/ratings-summary?ids=${ids}`, { cache: 'no-store' }).then(r => r.json()),
            fetch(`/api/restaurants/open-status?ids=${ids}`,     { cache: 'no-store' }).then(r => r.json()),
          ])
          if (cancelled) return
          if (ratingRes?.summary) setRatings(ratingRes.summary)
          if (statusRes?.status)  setOpenStatus(statusRes.status)
        } catch { /* keep fallbacks */ }
      }
    })()
    return () => { cancelled = true }
  }, [open, city])

  // The city's upcoming events, loaded with the restaurants.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    supabase.from('events')
      .select(`id, title, category, venue, neighborhood, description, ${EVENT_DATE_COLUMNS}`)
      .eq('is_active', true).eq('city', city)
      .order('date', { ascending: true }).limit(200)
      .then(({ data }) => {
        if (!cancelled) setEvents(((data ?? []) as unknown as SearchEvent[]).filter(e => !isPastEvent(e)))
      })
    return () => { cancelled = true }
  }, [open, city])

  // Dish-name hits (lib/dishSearch.ts, shared with the restaurant list).
  const { hits: menuHits, searching: menuSearching } = useDishHits(query, open)

  const commitRecent = useCallback((raw: string) => {
    const q = raw.trim()
    if (q.length < 2) return
    setRecents(prev => {
      const next = [q, ...prev.filter(r => r.toLowerCase() !== q.toLowerCase())].slice(0, RECENTS_MAX)
      writeRecents(next)
      return next
    })
  }, [])

  // Local matches first (name / cuisine / neighborhood), then restaurants
  // reached only through a menu-item hit — so a dish search still finds
  // the venue that cooks it.
  const results = useMemo(() => {
    const q = normalizeCuisine(query.trim())
    if (!q) return [] as Restaurant[]
    const direct: Restaurant[] = []
    const viaMenu: Restaurant[] = []
    for (const r of restaurants) {
      const haystack = normalizeCuisine([
        r.name, r.cuisine_type, r.description, r.neighborhood, r.address,
      ].filter(Boolean).join(' '))
      if (haystack.includes(q)) direct.push(r)
      else if (menuHits[r.id]) viaMenu.push(r)
    }
    return [...direct, ...viaMenu]
  }, [query, restaurants, menuHits])

  const eventResults = useMemo(() => {
    const q = normalizeCuisine(query.trim())
    if (!q) return [] as SearchEvent[]
    return events.filter(e => normalizeCuisine([e.title, e.category, e.venue, e.neighborhood, e.description]
      .filter(Boolean).join(' ')).includes(q)).slice(0, 20)
  }, [query, events])

  if (!open) return null

  const trimmed = query.trim()

  return (
    <div className={`${desktop ? '' : 'md:hidden '}fixed inset-0 z-50 bg-surface flex flex-col`}>
      {/* Search bar */}
      <div className="flex-shrink-0 border-b border-divider px-3 py-2.5 flex items-center gap-2">
        <button
          type="button"
          onClick={onClose}
          aria-label={bi('Fermer la recherche', 'Close search')}
          className="w-10 h-10 flex items-center justify-center rounded-full text-ink-secondary hover:bg-surface-muted transition-colors text-xl"
        >
          ←
        </button>
        <form
          className="flex-1"
          role="search"
          onSubmit={e => { e.preventDefault(); commitRecent(query); inputRef.current?.blur() }}
        >
          <label className="relative block">
            <span className="absolute inset-y-0 left-3 flex items-center text-ink-tertiary pointer-events-none">🔍</span>
            <input
              ref={inputRef}
              type="search"
              value={query}
              onChange={e => setQuery(e.target.value)}
              enterKeyHint="search"
              placeholder={bi('Un plat, un restaurant, un événement…', 'A dish, a restaurant, an event…')}
              className="w-full bg-surface-muted border border-transparent focus:border-brand focus:bg-surface rounded-full pl-9 pr-9 py-2.5 text-sm text-ink-primary placeholder-ink-tertiary outline-none transition-colors"
            />
            {query && (
              <button
                type="button"
                onClick={() => { setQuery(''); inputRef.current?.focus() }}
                aria-label={bi('Effacer', 'Clear')}
                className="absolute inset-y-0 right-2 flex items-center text-ink-tertiary hover:text-ink-primary px-1"
              >
                ✕
              </button>
            )}
          </label>
        </form>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 pb-24">
        {/* Recent searches — only while the field is empty. */}
        {!trimmed && (
          <>
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-sm font-bold text-ink-primary">
                {bi('Recherches récentes', 'Recent searches')}
              </h2>
              {recents.length > 0 && (
                <button
                  onClick={() => { setRecents([]); writeRecents([]) }}
                  className="text-xs text-ink-tertiary hover:text-ink-primary"
                >
                  {bi('Effacer', 'Clear')}
                </button>
              )}
            </div>
            {recents.length === 0 ? (
              <p className="text-sm text-ink-tertiary">
                {bi('Cherchez un plat, un restaurant ou un quartier.', 'Search for a dish, a restaurant or an area.')}
              </p>
            ) : (
              <ul className="divide-y divide-divider">
                {recents.map(r => (
                  <li key={r}>
                    <button
                      onClick={() => { setQuery(r); inputRef.current?.focus() }}
                      className="w-full flex items-center gap-3 py-3 text-left text-sm text-ink-primary"
                    >
                      <span aria-hidden="true" className="text-ink-tertiary">🕐</span>
                      <span className="flex-1 truncate">{r}</span>
                      <span aria-hidden="true" className="text-ink-tertiary">↗</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}

        {/* Results */}
        {trimmed && (
          <>
            {loading ? (
              <div className="grid grid-cols-2 gap-3">
                {Array.from({ length: 4 }).map((_, i) => <RestaurantCardSkeleton key={i} />)}
              </div>
            ) : results.length > 0 || eventResults.length > 0 ? (
              <>
                {eventResults.length > 0 && (
                  <div className="mb-5">
                    <h2 className="text-sm font-bold text-ink-primary mb-2">🎉 {bi('Événements', 'Events')}</h2>
                    <ul className="divide-y divide-divider bg-white rounded-2xl border border-divider">
                      {eventResults.map(e => (
                        <li key={e.id}>
                          <Link href={`/events/${e.id}`} onClick={() => { commitRecent(query); onClose() }}
                            className="flex flex-col px-3 py-2.5 hover:bg-surface-muted">
                            <span className="text-sm font-semibold text-ink-primary truncate">{e.title}</span>
                            <span className="text-xs text-ink-tertiary truncate">📅 {formatEventWhen(e, locale, 'card')}{e.venue ? ` · 📍 ${e.venue}` : ''}</span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {results.length > 0 && <h2 className="text-sm font-bold text-ink-primary mb-2">🍽️ {bi('Restaurants', 'Restaurants')}</h2>}
                <p className={`text-xs text-ink-secondary mb-3 ${results.length === 0 ? 'hidden' : ''}`}>
                  <span className="font-semibold text-ink-primary">{results.length}</span>{' '}
                  {bi('résultat(s)', 'result(s)')} · {city}
                  {menuSearching && <span className="text-ink-tertiary"> · {bi('recherche des plats…', 'searching dishes…')}</span>}
                </p>
                <div className={`grid grid-cols-2 ${desktop ? 'md:grid-cols-4' : ''} gap-3`}>
                  {results.map(r => (
                    <div key={r.id}>
                      <RestaurantCard
                        restaurant={r}
                        rating={ratings[r.id]}
                        openOverride={openStatus[r.id]?.open}
                      />
                      {menuHits[r.id] && (
                        <p className="text-[10px] text-ink-tertiary mt-1 px-1 truncate">
                          {bi('Au menu', 'On the menu')}: {menuHits[r.id]}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </>
            ) : menuSearching ? (
              <p className="text-sm text-ink-tertiary py-10 text-center">
                {bi('Recherche…', 'Searching…')}
              </p>
            ) : (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <div className="w-16 h-16 bg-surface-muted rounded-full flex items-center justify-center text-3xl mb-4">🔍</div>
                <h2 className="text-base font-bold text-ink-primary mb-1">
                  {bi('Aucun résultat', 'No matches')}
                </h2>
                <p className="text-sm text-ink-secondary max-w-xs">
                  {bi(`Rien pour « ${trimmed} » à ${city}.`, `Nothing for “${trimmed}” in ${city}.`)}
                </p>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
