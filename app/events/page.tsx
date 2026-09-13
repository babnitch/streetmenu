'use client'

export const dynamic = 'force-dynamic'

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import dynamicImport from 'next/dynamic'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { Event } from '@/types'
import { useLanguage, useBi } from '@/lib/languageContext'
import { categoryLabel } from '@/lib/categoryLabels'
import { useCity } from '@/lib/cityContext'
import { MAX_PROMOS_PER_PAGE } from '@/lib/promotions'
import { isPastEvent, formatEventDates, formatEventWhen } from '@/lib/eventDate'
import {
  addDays, eventDaySet, eventsOnDays, localDayISO, nextEventDay, pastEvents, selectionDays,
  type DaySelection,
} from '@/lib/eventCalendar'
import TopNav from '@/components/TopNav'
import EventCard, { EventCardSkeleton } from '@/components/EventCard'
import DayStrip from '@/components/DayStrip'
import MonthPicker from '@/components/MonthPicker'

const Map = dynamicImport(() => import('@/components/Map'), { ssr: false })

// City → Mapbox center + zoom. Kept in sync with app/page.tsx.
const CITY_CENTERS: Record<string, { center: [number, number]; zoom: number }> = {
  'Yaoundé': { center: [11.5021, 3.848],    zoom: 13 },
  'Abidjan': { center: [-4.0083, 5.36],      zoom: 13 },
  'Dakar':   { center: [-17.4441, 14.6937],  zoom: 13 },
  'Lomé':    { center: [1.2123, 6.1375],     zoom: 13 },
}

const CATEGORIES = [
  'Concert', 'Festival', 'BT/Club', 'Sport', 'Culture', 'Gastronomie', 'Enfants', 'Business', 'Autre',
]

interface MySubscription {
  id: string
  city: string
  categories: string[] | null
  is_active: boolean
}

export default function EventsPage() {
  const { t, locale } = useLanguage()
  const bi = useBi()
  const router = useRouter()
  const { city } = useCity()
  const [events, setEvents] = useState<Event[]>([])
  // Per-event tier prices keyed by event_id. Empty array (or missing key)
  // means the event has no tiers — the card falls back to event.price.
  const [tierPrices, setTierPrices] = useState<Record<string, number[]>>({})
  const [likesSummary, setLikesSummary] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [selectedCategory, setSelectedCategory] = useState('all')
  const [showMap, setShowMap] = useState(false)
  const [mapSelected, setMapSelected] = useState<Event | null>(null)

  // ── Calendar ──────────────────────────────────────────────────────────────
  // "Today" is the phone's local date, read after mount: the server renders in
  // UTC, so reading it during render would mismatch the client. The strip shows
  // skeleton pills until it is set. The page always lands on Today — it never
  // jumps ahead on its own; an empty day offers "Prochain événement →" instead.
  const [today, setToday] = useState<string | null>(null)
  const [selection, setSelection] = useState<DaySelection>({ kind: 'day', day: '' })
  const [calendarOpen, setCalendarOpen] = useState(false)
  const calendarButtonRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const day = localDayISO()
    setToday(day)
    setSelection({ kind: 'day', day })
  }, [])

  // Auth state — drives the "Publish an event" button target. Logged-in
  // customers go straight to /events/submit; everyone else is routed
  // through the login gate with a return URL so they land back on submit.
  const [isCustomer, setIsCustomer] = useState(false)
  useEffect(() => {
    fetch('/api/auth/me', { cache: 'no-store' })
      .then(r => r.json())
      .then(d => setIsCustomer(d?.user?.role === 'customer'))
      .catch(() => setIsCustomer(false))
  }, [])
  const publishHref = isCustomer ? '/events/submit' : '/account?return=/events/submit'

  // Subscription state
  const [mySubs, setMySubs] = useState<MySubscription[]>([])
  const [subModalOpen, setSubModalOpen] = useState(false)
  const [subCategories, setSubCategories] = useState<Set<string>>(new Set(CATEGORIES))
  const [subSaving, setSubSaving] = useState(false)
  const [subToast, setSubToast] = useState<string | null>(null)

  const currentSub = mySubs.find(s => s.city === city && s.is_active)

  const loadSubscriptions = useCallback(async () => {
    try {
      const res = await fetch('/api/subscriptions/my', { cache: 'no-store' })
      const d = await res.json()
      if (Array.isArray(d?.subscriptions)) setMySubs(d.subscriptions)
    } catch { /* anon user — empty */ }
  }, [])

  useEffect(() => { loadSubscriptions() }, [loadSubscriptions])

  function openSubModal() {
    if (currentSub) {
      setSubCategories(new Set(currentSub.categories ?? CATEGORIES))
    } else {
      setSubCategories(new Set(CATEGORIES))
    }
    setSubModalOpen(true)
  }

  function toggleSubCategory(cat: string) {
    setSubCategories(prev => {
      const next = new Set(prev)
      if (next.has(cat)) next.delete(cat)
      else next.add(cat)
      return next
    })
  }

  async function saveSubscription() {
    setSubSaving(true)
    try {
      const isAll = subCategories.size === CATEGORIES.length
      const res = await fetch('/api/subscriptions/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          city,
          categories: isAll ? null : Array.from(subCategories),
        }),
      })
      const d = await res.json()
      if (!res.ok) {
        if (res.status === 401) {
          setSubToast(bi('Connectez-vous pour vous abonner', 'Log in to subscribe'))
          setSubModalOpen(false)
          setTimeout(() => router.push('/account'), 1200)
          return
        }
        throw new Error(d?.error ?? 'Error')
      }
      setSubToast(bi(
        '🔔 Vous recevrez les nouveaux événements par WhatsApp!',
        '🔔 You\'ll receive new events via WhatsApp!',
      ))
      setSubModalOpen(false)
      await loadSubscriptions()
    } catch (e) {
      setSubToast((e as Error).message)
    } finally {
      setSubSaving(false)
      setTimeout(() => setSubToast(null), 3500)
    }
  }

  async function unsubscribeFromCity() {
    if (!currentSub) return
    setSubSaving(true)
    try {
      const res = await fetch('/api/subscriptions/unsubscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ city }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d?.error ?? 'Error')
      }
      setSubToast(bi('🔕 Désabonné', '🔕 Unsubscribed'))
      setSubModalOpen(false)
      await loadSubscriptions()
    } catch (e) {
      setSubToast((e as Error).message)
    } finally {
      setSubSaving(false)
      setTimeout(() => setSubToast(null), 3500)
    }
  }

  useEffect(() => {
    async function fetchEvents() {
      const { data } = await supabase
        .from('events')
        .select('*')
        .eq('is_active', true)
        .order('date', { ascending: true })
      if (data) setEvents(data)
      setLoading(false)

      // Like counts. Best-effort follow-up so the grid paints first; failure
      // just hides the ❤️ N line on each card.
      if (data && data.length > 0) {
        // Tier prices for cards that should show a range. One query for the
        // whole grid; group on the client.
        try {
          const ids = data.map(e => e.id)
          const { data: tRows } = await supabase
            .from('event_ticket_tiers')
            .select('event_id, price, is_active')
            .in('event_id', ids)
            .eq('is_active', true)
          if (tRows) {
            const map: Record<string, number[]> = {}
            for (const r of tRows) {
              const k = r.event_id as string
              ;(map[k] ??= []).push(Number(r.price ?? 0))
            }
            setTierPrices(map)
          }
        } catch { /* card falls back to event.price */ }

        try {
          const idList = data.map(e => e.id).join(',')
          const res = await fetch(`/api/events/likes-summary?ids=${idList}`, { cache: 'no-store' })
          const d = await res.json()
          if (d?.summary && typeof d.summary === 'object') setLikesSummary(d.summary)
        } catch { /* card just hides the line */ }
      }
    }
    fetchEvents()
  }, [])

  // TopNav map button dispatches this event; we toggle the overlay.
  useEffect(() => {
    const onToggle = () => setShowMap(prev => !prev)
    window.addEventListener('nt-toggle-map', onToggle)
    return () => window.removeEventListener('nt-toggle-map', onToggle)
  }, [])

  // City + category narrow everything below: the day list, the dots and "À la une".
  const filtered = useMemo(() => events.filter(e => {
    const cityMatch = e.city === city
    const catMatch = selectedCategory === 'all' || e.category === selectedCategory
    return cityMatch && catMatch
  }), [events, city, selectedCategory])

  // Days with at least one event, from today on — the dots in the strip and picker.
  const eventDays = useMemo(
    () => (today ? eventDaySet(filtered, today) : new Set<string>()),
    [filtered, today],
  )

  // The days the selection covers, and what the list shows for it: the
  // selected day's (or weekend's) events, or finished ones for "Passés".
  const coveredDays = today ? selectionDays(selection, today) : []
  const listEvents = useMemo(() => {
    if (!today) return []
    return selection.kind === 'past'
      ? pastEvents(filtered)
      : eventsOnDays(filtered, selectionDays(selection, today))
  }, [filtered, selection, today])

  // Where "Prochain événement →" jumps when the selection is empty.
  const nextDay = selection.kind === 'past' || coveredDays.length === 0
    ? null
    : nextEventDay(eventDays, coveredDays[coveredDays.length - 1])

  // "Aujourd'hui · dim. 13 sept." — heads the list and the map.
  const selectionHeading = (() => {
    if (!today) return ''
    if (selection.kind === 'past') return bi('Événements passés', 'Past events')
    const dates = formatEventDates({ date: coveredDays[0], end_date: coveredDays[coveredDays.length - 1] }, 'fr', 'list')
    if (selection.kind === 'weekend') return `${bi('Ce week-end', 'This weekend')} · ${dates}`
    if (selection.day === today) return `${bi("Aujourd'hui", 'Today')} · ${dates}`
    if (selection.day === addDays(today, 1)) return `${bi('Demain', 'Tomorrow')} · ${dates}`
    return dates
  })()

  // Active event promotions for this city → the "À la une" row below.
  const [eventPromos, setEventPromos] = useState<Array<{ id: string; target_id: string; placement: 'top_list' | 'feed_card' | 'banner' }>>([])
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(`/api/promotions/active?city=${encodeURIComponent(city)}&type=event`, { cache: 'no-store' })
        const d = await res.json()
        if (!cancelled && Array.isArray(d?.promotions)) {
          setEventPromos(d.promotions.map((p: { id: string; target_id: string; placement: 'top_list' | 'feed_card' | 'banner' }) => ({
            id: p.id, target_id: p.target_id, placement: p.placement,
          })))
        }
      } catch { /* render un-promoted on failure */ }
    })()
    return () => { cancelled = true }
  }, [city])

  // "À la une": up to MAX_PROMOS_PER_PAGE promoted events, shown whatever day is
  // selected so a paid placement keeps its exposure. top_list before
  // feed_card, each event once, and only upcoming events in the current
  // city/category — a paid slot must never resurrect a finished event.
  const featured = useMemo(() => {
    // Plain record (not `new Map(...)`): `Map` in this file is the Mapbox component.
    const upcomingById: Record<string, Event> = {}
    for (const e of filtered) if (!isPastEvent(e)) upcomingById[e.id] = e
    const ordered = [
      ...eventPromos.filter(p => p.placement === 'top_list'),
      ...eventPromos.filter(p => p.placement === 'feed_card'),
    ]
    const rows: Array<{ event: Event; promotionId: string }> = []
    for (const promo of ordered) {
      const event = upcomingById[promo.target_id]
      if (!event || rows.some(r => r.event.id === event.id)) continue
      rows.push({ event, promotionId: promo.id })
      if (rows.length === MAX_PROMOS_PER_PAGE) break
    }
    return rows
  }, [filtered, eventPromos])

  const cityData = CITY_CENTERS[city] ?? CITY_CENTERS['Yaoundé']

  // Pins follow the selection: the events the list is showing, where they
  // have coordinates. Events without lat/lng stay in the list only.
  const mapMarkers = listEvents
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
        <div className="max-w-5xl mx-auto px-4 py-2.5 flex gap-2 overflow-x-auto scrollbar-hide">
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
              {categoryLabel(cat, locale)}
            </button>
          ))}
        </div>
      </div>

      {/* Main */}
      <main className="max-w-5xl mx-auto px-4 py-5 pb-32">

        {/* Page title */}
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold text-ink-primary">{t('evt.title')}</h1>
            <p className="text-sm text-ink-tertiary">{t('evt.sub')}</p>
          </div>
          <div className="flex-shrink-0 flex items-center gap-2">
            {/* Publish an event — orange outline, next to Subscribe. Routes
                logged-in customers straight to the submit form; logged-out
                visitors through the login gate, returning to submit after. */}
            <Link
              href={publishHref}
              className="text-xs font-semibold px-3 py-2 rounded-xl border border-brand text-brand bg-white hover:bg-brand-light transition-colors whitespace-nowrap"
            >
              {bi('📢 Publier un événement', '📢 Publish an event')}
            </Link>
            <button
              onClick={openSubModal}
              className={`text-xs font-semibold px-3 py-2 rounded-xl transition-colors whitespace-nowrap ${
                currentSub
                  ? 'bg-surface-muted text-ink-primary hover:bg-divider'
                  : 'bg-brand text-white hover:bg-brand-dark'
              }`}
            >
              {currentSub
                ? bi('🔕 Gérer mon abonnement', '🔕 Manage subscription')
                : bi('🔔 S\'abonner', '🔔 Subscribe')}
            </button>
          </div>
        </div>

        {/* À la une — promoted events, whatever day is selected */}
        {!loading && featured.length > 0 && (
          <section className="mb-5" aria-labelledby="events-featured-heading">
            <h2 id="events-featured-heading" className="text-sm font-bold text-ink-primary mb-3">
              ⭐ {bi('À la une', 'Featured')}
            </h2>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
              {featured.map(({ event, promotionId }) => (
                <EventCard
                  key={`featured-${promotionId}`}
                  event={event}
                  viewLabel={t('evt.viewDetail')}
                  freeLabel={t('evt.free')}
                  categoryDisplay={categoryLabel(event.category, locale)}
                  likes={likesSummary[event.id]}
                  promotionId={promotionId}
                  tierPrices={tierPrices[event.id]}
                />
              ))}
            </div>
          </section>
        )}

        {/* Skeletons — until the events AND the phone's date are known */}
        {(loading || !today) && (
          <>
            <div className="flex gap-2 mb-5 overflow-hidden" aria-hidden="true">
              {Array.from({ length: 7 }).map((_, i) => (
                <div key={i} className="h-[4.25rem] w-14 flex-shrink-0 rounded-2xl bg-surface-muted animate-pulse" />
              ))}
            </div>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
              {Array.from({ length: 6 }).map((_, i) => <EventCardSkeleton key={i} />)}
            </div>
          </>
        )}

        {/* Day strip + the selected day's events */}
        {!loading && today && filtered.length > 0 && (
          <>
            <DayStrip
              today={today}
              selection={selection}
              eventDays={eventDays}
              onSelect={setSelection}
              onOpenCalendar={() => setCalendarOpen(true)}
              calendarButtonRef={calendarButtonRef}
            />

            <h2 className="mt-5 mb-3 text-sm font-bold text-ink-primary flex items-center gap-2">
              {selectionHeading}
              {selection.kind === 'past' && listEvents.length > 0 && (
                <span className="text-xs font-semibold bg-surface-muted text-ink-tertiary px-2 py-0.5 rounded-full">
                  {listEvents.length}
                </span>
              )}
            </h2>

            {listEvents.length > 0 ? (
              <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
                {listEvents.map(e => (
                  <EventCard
                    key={e.id}
                    event={e}
                    viewLabel={t('evt.viewDetail')}
                    freeLabel={t('evt.free')}
                    categoryDisplay={categoryLabel(e.category, locale)}
                    likes={likesSummary[e.id]}
                    tierPrices={tierPrices[e.id]}
                    isPast={selection.kind === 'past'}
                  />
                ))}
              </div>
            ) : (
              <div className="flex flex-col items-center text-center py-12 px-4">
                <div className="w-16 h-16 bg-brand-light rounded-3xl flex items-center justify-center text-3xl mb-4" aria-hidden="true">
                  🗓️
                </div>
                <p className="text-base font-bold text-ink-primary">
                  {selection.kind === 'past'
                    ? bi('Aucun événement passé', 'No past events')
                    : selection.kind === 'weekend'
                      ? bi('Rien de prévu ce week-end', 'Nothing planned this weekend')
                      : bi('Rien de prévu ce jour', 'Nothing planned this day')}
                </p>
                {nextDay && (
                  <button
                    type="button"
                    onClick={() => setSelection({ kind: 'day', day: nextDay })}
                    className="mt-3 text-sm font-semibold text-brand hover:text-brand-dark rounded-lg px-2 py-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                  >
                    {bi('Prochain événement :', 'Next event:')} {formatEventDates({ date: nextDay, end_date: null }, 'fr', 'list')} →
                  </button>
                )}
              </div>
            )}
          </>
        )}

        {/* Empty state — no events at all in this city (and category) */}
        {!loading && today && filtered.length === 0 && (
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
          nt-toggle-map custom event. Drops a pin for each event the list is
          showing (the selected day's) that has coordinates. */}
      {showMap && (
        <div className="fixed inset-0 z-50 flex flex-col bg-surface">
          <div className="h-14 flex-shrink-0 bg-surface border-b border-divider flex items-center justify-between gap-3 px-4">
            <span className="min-w-0 truncate font-semibold text-ink-primary text-sm">
              {bi('Événements à', 'Events in')} {city}{selectionHeading ? ` · ${selectionHeading}` : ''}
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
                      📅 {formatEventWhen(mapSelected, 'fr', 'card')}
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

      {/* Month picker — mounted only while open, so it always starts on the
          selected day's month and returns focus to the 📅 button on close. */}
      {calendarOpen && today && (
        <MonthPicker
          today={today}
          selectedDay={selection.kind === 'day' ? selection.day : null}
          eventDays={eventDays}
          onPick={day => { setSelection({ kind: 'day', day }); setCalendarOpen(false) }}
          onClose={() => setCalendarOpen(false)}
          returnFocusRef={calendarButtonRef}
        />
      )}

      {/* Subscription modal */}
      {subModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-4 bg-black/40" onClick={() => setSubModalOpen(false)}>
          <div className="bg-white rounded-2xl shadow-card max-w-md w-full max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="p-5">
              <h3 className="text-lg font-bold text-ink-primary mb-1">
                {currentSub
                  ? bi('🔕 Gérer mon abonnement', '🔕 Manage subscription')
                  : bi('🔔 S\'abonner aux notifications', '🔔 Subscribe to notifications')}
              </h3>
              <p className="text-sm text-ink-tertiary mb-4">
                {bi(
                  `Recevez les nouveaux événements à ${city} par WhatsApp.`,
                  `Get new events in ${city} on WhatsApp.`,
                )}
              </p>

              <div className="mb-4">
                <div className="text-xs font-semibold text-ink-secondary mb-2">
                  {bi('Ville', 'City')}
                </div>
                <div className="bg-surface-muted px-3 py-2 rounded-xl text-sm text-ink-primary">
                  📍 {city}
                </div>
              </div>

              <div className="mb-4">
                <div className="flex items-center justify-between mb-2">
                  <div className="text-xs font-semibold text-ink-secondary">
                    {bi('Catégories', 'Categories')}
                  </div>
                  <button
                    type="button"
                    onClick={() => setSubCategories(prev =>
                      prev.size === CATEGORIES.length ? new Set() : new Set(CATEGORIES),
                    )}
                    className="text-xs font-semibold text-brand hover:text-brand-dark"
                  >
                    {subCategories.size === CATEGORIES.length
                      ? bi('Tout désélectionner', 'Deselect all')
                      : bi('Tout sélectionner', 'Select all')}
                  </button>
                </div>
                <div className="space-y-1.5">
                  {CATEGORIES.map(cat => (
                    <label key={cat} className="flex items-center gap-2 cursor-pointer text-sm">
                      <input
                        type="checkbox"
                        checked={subCategories.has(cat)}
                        onChange={() => toggleSubCategory(cat)}
                        className="w-4 h-4 rounded border-divider text-brand"
                      />
                      <span className="text-ink-primary">{categoryLabel(cat, locale)}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="flex flex-col gap-2">
                <button
                  onClick={saveSubscription}
                  disabled={subSaving || subCategories.size === 0}
                  className="w-full bg-brand hover:bg-brand-dark disabled:opacity-50 text-white font-semibold py-2.5 rounded-xl text-sm transition-colors"
                >
                  {subSaving
                    ? '…'
                    : currentSub
                      ? bi('💾 Mettre à jour', '💾 Update')
                      : bi('✅ S\'abonner', '✅ Subscribe')}
                </button>
                {currentSub && (
                  <button
                    onClick={unsubscribeFromCity}
                    disabled={subSaving}
                    className="w-full bg-rose-50 hover:bg-rose-100 disabled:opacity-50 text-rose-600 font-semibold py-2.5 rounded-xl text-sm transition-colors"
                  >
                    {bi('🔕 Se désabonner', '🔕 Unsubscribe')}
                  </button>
                )}
                <button
                  onClick={() => setSubModalOpen(false)}
                  className="w-full text-ink-tertiary hover:text-ink-primary font-medium py-2 text-sm transition-colors"
                >
                  {bi('Annuler', 'Cancel')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {subToast && (
        <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-[60] bg-ink-primary text-white text-sm font-semibold px-4 py-2.5 rounded-full shadow-card max-w-[90vw] text-center">
          {subToast}
        </div>
      )}

    </div>
  )
}
