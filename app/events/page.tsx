'use client'

export const dynamic = 'force-dynamic'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import TopNav from '@/components/TopNav'
import CityDropdown from '@/components/CityDropdown'
import SearchOverlay from '@/components/SearchOverlay'
import MonthPicker from '@/components/MonthPicker'
import EventPoster from '@/components/events/EventPoster'
import SubscribeButton from '@/components/events/SubscribeButton'
import { useBi, useLanguage } from '@/lib/languageContext'
import { useCity } from '@/lib/cityContext'
import { categoryLabel } from '@/lib/categoryLabels'
import { addDays, localDayISO, weekdayIndex } from '@/lib/eventCalendar'
import { eventDays as rangeDays, formatEventDates, formatEventDay } from '@/lib/eventDate'
import { eventStatus, statusText, type ListingDay } from '@/lib/eventStatus'
import { formatFCFA } from '@/lib/money'

interface ListingEvent {
  id: string; title: string; category: string | null; venue: string | null; neighborhood: string | null
  cover_photo: string | null; organizer_name: string | null
  date: string; time: string | null; end_date: string | null; end_time: string | null
  days: ListingDay[]; fromPrice: number | null; recentSeats7d: number
}
interface Promoted { promotion_id: string; event_id: string; placement: string }
type When = { kind: 'all' } | { kind: 'today' } | { kind: 'weekend' } | { kind: 'week' } | { kind: 'date'; day: string }

// The event's upcoming days: from the listing (with seats), else its dates.
const upcomingDays = (e: ListingEvent, today: string): string[] =>
  e.days.length ? e.days.map(d => d.date) : rangeDays(e).filter(d => d >= today)

// /events — "Sortir" (Ticketcorner-style, E2):
//   dark band (search, city, subscribe) · À LA UNE (one big poster) ·
//   Cette semaine (swipeable posters) · Tous les événements (Quand,
//   Catégorie, Gratuit, Ville; rows with a date block and one status line).
// Never empty: nothing matches → "Aucun événement …" + Prochains événements.
// Rows open the event page with no day chosen (multi-day → its date list).
export default function EventsPage() {
  const bi = useBi()
  const { locale } = useLanguage()
  const { city } = useCity()
  const [today, setToday] = useState<string>('')
  const [data, setData] = useState<{ events: ListingEvent[]; featuredId: string | null; promoted: Promoted[] } | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [when, setWhen] = useState<When>({ kind: 'all' })
  const [category, setCategory] = useState<string | null>(null)
  const [freeOnly, setFreeOnly] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const pickerRef = useRef<HTMLButtonElement>(null)

  useEffect(() => { setToday(localDayISO()) }, [])

  useEffect(() => {
    let cancelled = false
    setData(null)
    fetch(`/api/events/listing?city=${encodeURIComponent(city)}`, { cache: 'no-store' })
      .then(r => r.json())
      .then(d => { if (!cancelled) setData({ events: d?.events ?? [], featuredId: d?.featuredId ?? null, promoted: d?.promoted ?? [] }) })
      .catch(() => { if (!cancelled) setData({ events: [], featuredId: null, promoted: [] }) })
    return () => { cancelled = true }
  }, [city])

  const events = useMemo(() => data?.events ?? [], [data])
  const promotedBy = useMemo(() => {
    const m: Record<string, Promoted> = {}
    for (const p of data?.promoted ?? []) if (!m[p.event_id]) m[p.event_id] = p
    return m
  }, [data])

  // The days a "Quand" choice covers (inclusive), or null = no date filter.
  const range = useMemo((): string[] | null => {
    if (!today || when.kind === 'all') return null
    if (when.kind === 'today') return [today]
    if (when.kind === 'date') return [when.day]
    if (when.kind === 'week') return Array.from({ length: 7 }, (_, i) => addDays(today, i))
    const wd = weekdayIndex(today)              // 0 = Monday … 6 = Sunday
    if (wd === 6) return [today]
    if (wd === 5) return [today, addDays(today, 1)]
    const sat = addDays(today, 5 - wd)
    return [sat, addDays(sat, 1)]
  }, [when, today])

  const categories = useMemo(
    () => Array.from(new Set(events.map(e => e.category).filter(Boolean) as string[])),
    [events],
  )

  // Base filters (Catégorie, Gratuit), then Quand; each row keeps the day it
  // is shown for (the first matching day).
  const base = useMemo(() => events.filter(e =>
    (!category || e.category === category) && (!freeOnly || e.fromPrice === 0)), [events, category, freeOnly])
  const rows = useMemo(() => base.flatMap(e => {
    const days = upcomingDays(e, today)
    const shown = range ? days.find(d => range.includes(d)) : days[0]
    return shown ? [{ e, shown }] : []
  }).sort((a, b) => a.shown.localeCompare(b.shown)), [base, range, today])

  // Never empty: the next events after the range (else any upcoming one).
  const nextUp = useMemo(() => {
    if (rows.length > 0) return []
    const after = range ? range[range.length - 1] : ''
    const pool = (base.length ? base : events).flatMap(e => {
      const d = upcomingDays(e, today).find(x => x > after)
      return d ? [{ e, shown: d }] : []
    })
    return pool.sort((a, b) => a.shown.localeCompare(b.shown)).slice(0, 6)
  }, [rows.length, range, base, events, today])

  // Cette semaine: a day in the next 7 days; paid promotions first.
  const week = useMemo(() => {
    if (!today) return []
    const end = addDays(today, 6)
    return events
      .map(e => ({ e, first: upcomingDays(e, today).find(d => d <= end) }))
      .filter((x): x is { e: ListingEvent; first: string } => !!x.first)
      .sort((a, b) => (promotedBy[b.e.id] ? 1 : 0) - (promotedBy[a.e.id] ? 1 : 0) || a.first.localeCompare(b.first))
      .slice(0, 10)
  }, [events, today, promotedBy])

  const featured = events.find(e => e.id === data?.featuredId) ?? null
  const allDays = useMemo(() => new Set(events.flatMap(e => upcomingDays(e, today))), [events, today])

  const priceText = (p: number | null) => p === null ? null : p === 0 ? bi('Gratuit', 'Free') : `${bi('Dès', 'From')} ${formatFCFA(p)}`
  const whenLabel = (): string => {
    switch (when.kind) {
      case 'today':   return bi("aujourd'hui", 'today')
      case 'weekend': return bi('ce week-end', 'this weekend')
      case 'week':    return bi('cette semaine', 'this week')
      case 'date':    return `${bi('le', 'on')} ${formatEventDay(when.day, locale, 'list')}`
      default:        return ''
    }
  }

  return (
    <div className="min-h-screen bg-surface">
      <TopNav />
      <SearchOverlay open={searchOpen} onClose={() => setSearchOpen(false)} desktop />

      {/* Dark band */}
      <section className="bg-ink-primary text-white">
        <div className="max-w-3xl mx-auto px-4 pt-5 pb-6">
          <p className="text-sm text-white/80">
            {bi(`Sorties à ${city} : concerts, culture, sport, ateliers`, `Going out in ${city}: concerts, culture, sport, workshops`)}
          </p>
          <button type="button" onClick={() => setSearchOpen(true)}
            className="mt-3 w-full flex items-center gap-3 bg-white text-left rounded-2xl px-4 py-3.5 shadow-sm">
            <span aria-hidden="true">🔍</span>
            <span className="text-sm text-ink-tertiary">{bi('Rechercher un événement, un artiste, un lieu', 'Search an event, an artist, a place')}</span>
          </button>
          <div className="mt-3 flex items-center gap-2 flex-wrap">
            <div className="bg-white rounded-full"><CityDropdown /></div>
            <SubscribeButton />
          </div>
        </div>
      </section>

      <main className="max-w-3xl mx-auto px-4 pt-5 pb-28 md:pb-12">
        {!data || !today ? (
          <div className="space-y-3" aria-hidden="true">
            <div className="h-72 rounded-2xl bg-surface-muted animate-pulse" />
            <div className="h-20 rounded-2xl bg-surface-muted animate-pulse" />
            <div className="h-20 rounded-2xl bg-surface-muted animate-pulse" />
          </div>
        ) : (
          <>
            {/* À LA UNE */}
            {featured && (
              <section aria-labelledby="featured-heading" className="mb-7">
                <h2 id="featured-heading" className="text-xs font-bold tracking-widest text-ink-tertiary mb-2">{bi('À LA UNE', 'FEATURED')}</h2>
                <PromoLink promo={promotedBy[featured.id]} href={`/events/${featured.id}`}
                  className="block relative rounded-2xl overflow-hidden shadow-card">
                  <EventPoster src={featured.cover_photo} title={featured.title} category={featured.category}
                    className="aspect-[4/5] sm:aspect-[16/10] w-full" rounded="rounded-none" sizes="(max-width: 768px) 100vw, 768px" priority />
                  <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/50 to-transparent p-4 pt-16 text-white">
                    {promotedBy[featured.id] && <span className="text-[10px] font-semibold opacity-80">{bi('Sponsorisé', 'Sponsored')}</span>}
                    <p className="text-xl font-black leading-tight">{featured.title}</p>
                    <p className="text-sm opacity-90 mt-1">📅 {formatEventDates(featured, locale, 'card')}</p>
                    {featured.venue && <p className="text-sm opacity-90">📍 {featured.venue}</p>}
                    {priceText(featured.fromPrice) && <p className="text-sm font-bold mt-1">{priceText(featured.fromPrice)}</p>}
                  </div>
                </PromoLink>
              </section>
            )}

            {/* Cette semaine */}
            {week.length > 0 && (
              <section aria-labelledby="week-heading" className="mb-7">
                <h2 id="week-heading" className="text-base font-bold text-ink-primary mb-3">{bi('Cette semaine', 'This week')}</h2>
                <div className="flex gap-3 overflow-x-auto pb-2 -mx-4 px-4 snap-x [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                  {week.map(({ e }) => (
                    <PromoLink key={e.id} promo={promotedBy[e.id]} href={`/events/${e.id}`} className="flex-shrink-0 w-36 snap-start">
                      <EventPoster src={e.cover_photo} title={e.title} category={e.category} className="aspect-[4/5] w-full shadow-sm" sizes="144px" />
                      <p className="mt-1.5 text-sm font-semibold text-ink-primary leading-tight line-clamp-2">{e.title}</p>
                      <p className="text-xs text-ink-tertiary">
                        {promotedBy[e.id] ? `${bi('Sponsorisé', 'Sponsored')} · ` : ''}{priceText(e.fromPrice) ?? ''}
                      </p>
                    </PromoLink>
                  ))}
                </div>
              </section>
            )}

            {/* Tous les événements */}
            <section aria-labelledby="all-heading">
              <h2 id="all-heading" className="text-base font-bold text-ink-primary mb-3">{bi('Tous les événements', 'All events')}</h2>
              <div className="flex gap-2 overflow-x-auto pb-2 -mx-4 px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                {([
                  ['today', bi("Aujourd'hui", 'Today')],
                  ['weekend', bi('Ce week-end', 'This weekend')],
                  ['week', bi('Cette semaine', 'This week')],
                ] as const).map(([k, l]) => (
                  <Chip key={k} active={when.kind === k} onClick={() => setWhen(when.kind === k ? { kind: 'all' } : { kind: k })}>{l}</Chip>
                ))}
                <button ref={pickerRef} type="button" onClick={() => setPickerOpen(true)} className={chipCls(when.kind === 'date')}>
                  📅 {when.kind === 'date' ? formatEventDay(when.day, locale, 'compact') : bi('Choisir une date', 'Pick a date')}
                </button>
                {categories.length > 1 && (
                  <select value={category ?? ''} onChange={e => setCategory(e.target.value || null)}
                    aria-label={bi('Catégorie', 'Category')} className={chipCls(!!category)}>
                    <option value="">{bi('Catégorie', 'Category')}</option>
                    {categories.map(c => <option key={c} value={c}>{categoryLabel(c, locale)}</option>)}
                  </select>
                )}
                {(freeOnly || events.some(e => e.fromPrice === 0)) && (
                  <Chip active={freeOnly} onClick={() => setFreeOnly(v => !v)}>{bi('Gratuit', 'Free')}</Chip>
                )}
              </div>

              {rows.length > 0 ? (
                <ul className="mt-2 space-y-2">
                  {rows.map(({ e, shown }) => <EventRow key={e.id} e={e} shown={shown} today={today} priceText={priceText} />)}
                </ul>
              ) : (
                <div className="mt-4">
                  <p className="text-sm font-semibold text-ink-primary">
                    {events.length === 0
                      ? bi(`Pas encore d'événement à ${city}.`, `No events in ${city} yet.`)
                      : when.kind === 'all'
                        ? bi('Aucun événement pour ces critères.', 'No events match.')
                        : bi(`Aucun événement ${whenLabel()}.`, `No events ${whenLabel()}.`)}
                  </p>
                  {nextUp.length > 0 && (
                    <>
                      <h3 className="text-sm font-bold text-ink-primary mt-4 mb-2">{bi('Prochains événements', 'Next events')}</h3>
                      <ul className="space-y-2">
                        {nextUp.map(({ e, shown }) => <EventRow key={e.id} e={e} shown={shown} today={today} priceText={priceText} />)}
                      </ul>
                    </>
                  )}
                </div>
              )}
            </section>

            <p className="text-center mt-10">
              <Link href="/events/submit" className="text-sm font-semibold text-brand-darker hover:underline">
                📢 {bi('Organiser un événement', 'Organise an event')} →
              </Link>
            </p>
          </>
        )}
      </main>

      {pickerOpen && today && (
        <MonthPicker
          today={today}
          selectedDay={when.kind === 'date' ? when.day : null}
          eventDays={allDays}
          onPick={day => { setWhen({ kind: 'date', day }); setPickerOpen(false) }}
          onClose={() => setPickerOpen(false)}
          returnFocusRef={pickerRef}
        />
      )}
    </div>
  )
}

const chipCls = (active: boolean) =>
  `flex-shrink-0 text-xs font-semibold px-3 py-2 rounded-full border whitespace-nowrap transition-colors ${
    active ? 'bg-ink-primary text-white border-ink-primary' : 'bg-white text-ink-secondary border-divider'
  }`

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button type="button" aria-pressed={active} onClick={onClick} className={chipCls(active)}>{children}</button>
}

// A row: big date block, then name, place, price and one status line.
function EventRow({ e, shown, today, priceText }: {
  e: ListingEvent; shown: string; today: string; priceText: (p: number | null) => string | null
}) {
  const bi = useBi()
  const { locale } = useLanguage()
  const days = upcomingDays(e, today)
  const multi = days.length > 1 || (!!e.end_date && e.end_date !== e.date)
  const d = new Date(`${shown}T00:00:00Z`)
  const tag = locale === 'en' ? 'en-GB' : 'fr-FR'
  const month = new Intl.DateTimeFormat(tag, { month: 'short', timeZone: 'UTC' }).format(d).replace('.', '').toUpperCase()
  const weekday = new Intl.DateTimeFormat(tag, { weekday: 'short', timeZone: 'UTC' }).format(d)
  const status = statusText(eventStatus(e.days, shown, e.recentSeats7d), today, locale, iso => formatEventDay(iso, locale, 'compact'))
  const statusTone = status && /Épuisé|Sold out/.test(status) ? 'text-danger' : 'text-amber-700'

  return (
    <li>
      <Link href={`/events/${e.id}`} className="flex gap-3 bg-white rounded-2xl border border-divider p-3 hover:shadow-sm transition-shadow">
        <div className="w-16 flex-shrink-0 rounded-xl bg-surface-muted flex flex-col items-center justify-center text-center py-2">
          {multi ? (
            <>
              <span className="text-[11px] font-bold text-ink-primary leading-tight px-1">
                {formatEventDates({ date: days[0] ?? e.date, end_date: days[days.length - 1] ?? e.end_date }, locale, 'compact')}
              </span>
              <span className="text-[10px] text-ink-tertiary mt-0.5">{days.length} {bi('dates', 'dates')}</span>
            </>
          ) : (
            <>
              <span className="text-xl font-black text-ink-primary leading-none">{Number(shown.slice(8))}</span>
              <span className="text-[10px] font-bold text-brand-darker">{month}</span>
              <span className="text-[10px] text-ink-tertiary">{weekday}{e.time ? ` · ${e.time.slice(0, 5)}` : ''}</span>
            </>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-bold text-ink-primary leading-tight line-clamp-2">{e.title}</p>
          {(e.venue || e.neighborhood) && (
            <p className="text-xs text-ink-tertiary truncate mt-0.5">📍 {[e.venue, e.neighborhood].filter(Boolean).join(', ')}</p>
          )}
          {priceText(e.fromPrice) && <p className="text-xs font-semibold text-ink-primary mt-0.5">{priceText(e.fromPrice)}</p>}
          {status && <p className={`text-xs font-semibold mt-0.5 ${statusTone}`}>{status}</p>}
        </div>
      </Link>
    </li>
  )
}

// A link that, when it is a paid promotion, reports the impression once and
// the click (same tracking as the old cards).
function PromoLink({ promo, href, className, children }: {
  promo?: Promoted; href: string; className?: string; children: React.ReactNode
}) {
  const ref = useRef<HTMLAnchorElement>(null)
  useEffect(() => {
    if (!promo || typeof IntersectionObserver === 'undefined' || !ref.current) return
    const el = ref.current
    const io = new IntersectionObserver(entries => {
      if (entries.some(x => x.isIntersecting)) {
        import('@/lib/promoTracking').then(m => m.fireImpression(promo.promotion_id))
        io.disconnect()
      }
    }, { threshold: 0.5 })
    io.observe(el)
    return () => io.disconnect()
  }, [promo])
  return (
    <Link ref={ref} href={href} className={className}
      onClick={() => { if (promo) import('@/lib/promoTracking').then(m => m.fireClick(promo.promotion_id)) }}>
      {children}
    </Link>
  )
}
