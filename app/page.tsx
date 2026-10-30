'use client'
import { useRefData } from '@/lib/useRefData'

import GeneratedCover from '@/components/GeneratedCover'
import SafeImage from '@/components/SafeImage'
import PhotoCredit from '@/components/PhotoCredit'
import { CompactRow, dot } from '@/components/CompactRow'
import { eventCategoryIcon } from '@/lib/categoryLabels'
import { placeCategory } from '@/lib/places'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import TopNav from '@/components/TopNav'
import SearchOverlay from '@/components/SearchOverlay'
import { useBi, useLanguage } from '@/lib/languageContext'
import { useCity } from '@/lib/cityContext'
import { useMode } from '@/lib/modeContext'
import { useDataMode } from '@/lib/dataMode'
import { loginHref } from '@/lib/lastPhone'
import { formatEventWhen, type EventWhen } from '@/lib/eventDate'
import { formatFCFA, formatAmount } from '@/lib/money'
import { formatPrepTime } from '@/lib/prepTime'
import { formatDeliveryTime } from '@/lib/delivery'
import { percentOffLabel } from '@/lib/offers'
import CardTag from '@/components/CardTag'
import { cuisineText } from '@/lib/cuisineCategories'
import { categoryLabel } from '@/lib/categoryLabels'
import { todayInDouala, weekendWindow, weekendDay, listingDays } from '@/lib/weekend'
import { pick, placeCategoryLabel, type PublicPlace } from '@/lib/places'
import { picturesFirst, hasPicture } from '@/lib/popularRanking'

interface PopularRestaurant {
  id: string; name: string; cuisine_type: string | null; neighborhood: string | null; image_url: string | null; logo_url: string | null
  prep_time_min: number | null; prep_time_max: number | null
  delivery_enabled: boolean | null; delivery_fee: number | null; delivery_extra_min: number | null; free_delivery?: boolean
}
interface PopularEvent extends EventWhen {
  id: string; title: string; category: string | null; venue: string | null; cover_photo: string | null
  price_from: number; is_free: boolean; has_tiers: boolean; price_unknown?: boolean; price_is_from?: boolean
}
interface WeekendEvent extends EventWhen {
  id: string; title: string; category: string | null; venue?: string | null; cover_photo: string | null
  date: string; end_date: string | null; time: string | null; end_time: string | null
  days: Array<{ date: string }>; fromPrice: number | null
}
interface TodayOffer {
  kind: 'price' | 'free_delivery'
  restaurant: { id: string; name: string; image: string | null }
  dish?: { id: string; name: string; photo_url: string | null; regular_price: number; offer_price: number }
}

// / — the landing page, for everyone (home v2, V3):
//   promise · one search (dishes, restaurants, events) — the city picker
//   is in the header (N1) ·
//   "Offres du jour" · "Restaurants populaires à [ville]" ·
//   "Événements populaires" — three horizontal rows, each hidden when empty ·
//   partner banner.
export default function HomePage() {
  const bi = useBi()
  useRefData()
  const { locale } = useLanguage()
  const { city } = useCity()
  const { sessionRole, loading: modeLoading } = useMode()
  const { isLowData } = useDataMode()
  const [searchOpen, setSearchOpen] = useState(false)
  const [popular, setPopular] = useState<{ restaurants: PopularRestaurant[]; events: PopularEvent[]; restaurantsPopular: boolean; eventsPopular: boolean } | null>(null)
  const [offers, setOffers] = useState<TodayOffer[]>([])
  // U3: "Ce week-end à {ville}" — the city's events on Friday 17:00 → Sunday.
  const [weekend, setWeekend] = useState<WeekendEvent[]>([])
  // I4: "Que faire à {ville} ?" — the city's places.
  const [places, setPlaces] = useState<PublicPlace[]>([])

  // Old links: /?q=… was the restaurant search.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get('q')
    if (q) window.location.replace(`/restaurants?q=${encodeURIComponent(q)}#search`)
  }, [])

  useEffect(() => {
    let cancelled = false
    setPopular(null)
    setOffers([])
    fetch(`/api/popular?city=${encodeURIComponent(city)}`, { cache: 'no-store' })
      .then(r => r.json())
      .then(d => { if (!cancelled) setPopular({ restaurants: d?.restaurants ?? [], events: d?.events ?? [], restaurantsPopular: d?.restaurants_popular === true, eventsPopular: d?.events_popular === true }) })
      .catch(() => { if (!cancelled) setPopular({ restaurants: [], events: [], restaurantsPopular: false, eventsPopular: false }) })
    setWeekend([])
    fetch(`/api/events/listing?city=${encodeURIComponent(city)}`, { cache: 'no-store' })
      .then(r => r.json())
      .then(d => {
        if (cancelled) return
        const today = todayInDouala()
        const w = weekendWindow(today)
        const list = ((d?.events ?? []) as WeekendEvent[])
          .map(e => ({ e, day: weekendDay(e, listingDays(e, today), w) }))
          .filter((x): x is { e: WeekendEvent; day: string } => !!x.day)
          .sort((a, b) => a.day.localeCompare(b.day) || (a.e.time ?? '').localeCompare(b.e.time ?? ''))
          .map(x => x.e)
        // Home: a real poster first, date order kept inside each group.
        setWeekend(picturesFirst(list, e => (hasPicture(e.cover_photo) ? 0 : 2)).slice(0, 10))
      })
      .catch(() => null)
    setPlaces([])
    fetch(`/api/places?city=${encodeURIComponent(city)}&limit=10&pictures_first=1`, { cache: 'no-store' })
      .then(r => r.json())
      .then(d => { if (!cancelled) setPlaces(Array.isArray(d?.places) ? d.places : []) })
      .catch(() => null)
    fetch(`/api/offers/today?city=${encodeURIComponent(city)}`, { cache: 'no-store' })
      .then(r => r.json())
      .then(d => {
        if (cancelled) return
        // Home: offers with a picture (dish photo, else restaurant photo) first.
        const list: TodayOffer[] = Array.isArray(d?.offers) ? d.offers : []
        setOffers(picturesFirst(list, o => (hasPicture(o.dish?.photo_url) || hasPicture(o.restaurant.image) ? 0 : 2)))
      })
      .catch(() => null)
    return () => { cancelled = true }
  }, [city])

  const partnerHref = !modeLoading && sessionRole ? '/pro' : loginHref('/pro')
  const img = (src: string | null | undefined) => (isLowData ? null : (src || null))

  // Mode économique rows say "Ouvert / Fermé": the same bulk status as the
  // Restaurants page, fetched only in that mode.
  const [openNow, setOpenNow] = useState<Record<string, boolean>>({})
  const restIds = (popular?.restaurants ?? []).map(r => r.id).join(',')
  useEffect(() => {
    if (!isLowData || !restIds) return
    fetch(`/api/restaurants/open-status?ids=${restIds}`).then(r => r.json())
      .then(d => setOpenNow(Object.fromEntries(Object.entries((d?.status ?? {}) as Record<string, { open?: boolean }>).map(([k, v]) => [k, !!v?.open]))))
      .catch(() => null)
  }, [isLowData, restIds])
  const openLabel = (id: string) => id in openNow ? (openNow[id] ? bi('Ouvert', 'Open') : bi('Fermé', 'Closed')) : null

  // "Livraison 500 FCFA · 35-50 min" / "Livraison offerte · …" / "À emporter · 20-35 min"
  const fulfilmentLine = (r: PopularRestaurant) => {
    if (r.delivery_enabled) {
      const time = formatDeliveryTime(r.prep_time_min, r.prep_time_max, r.delivery_extra_min)
      const fee = r.free_delivery || !r.delivery_fee
        ? bi('Livraison offerte', 'Free delivery')
        : `${bi('Livraison', 'Delivery')} ${formatFCFA(r.delivery_fee)}`
      return time ? `${fee} · ${time}` : fee
    }
    const time = formatPrepTime(r.prep_time_min, r.prep_time_max)
    return time ? `${bi('À emporter', 'Take-away')} · ${time}` : bi('À emporter', 'Take-away')
  }
  const eventPrice = (e: PopularEvent) => e.price_unknown ? ''
    : e.is_free
    ? bi('Gratuit', 'Free')
    : e.has_tiers || e.price_is_from ? `${bi('dès', 'from')} ${formatFCFA(e.price_from)}` : formatFCFA(e.price_from)

  return (
    <div className="min-h-screen bg-surface">
      <TopNav />
      <SearchOverlay open={searchOpen} onClose={() => setSearchOpen(false)} desktop />

      <main className="max-w-2xl mx-auto px-4 pt-6 pb-28 md:pb-12">
        <h1 className="text-2xl md:text-3xl font-black text-ink-primary leading-tight">
          {bi('Commandez à manger et réservez vos sorties', 'Order food and book outings')}
        </h1>

        <button type="button" onClick={() => setSearchOpen(true)}
          className="mt-4 w-full flex items-center gap-3 bg-white border border-divider rounded-2xl px-4 py-3.5 text-left shadow-sm hover:border-brand transition-colors">
          <span aria-hidden="true" className="text-lg">🔍</span>
          <span className="text-sm text-ink-tertiary">{bi('Un plat, un restaurant, un événement…', 'A dish, a restaurant, an event…')}</span>
        </button>

        {offers.length > 0 && (
          <Row id="offers" title={`🏷️ ${bi('Offres du jour', "Today's offers")}`}>
            {offers.map(o => (
              <Card key={`o-${o.restaurant.id}-${o.dish?.id ?? 'delivery'}`} href={`/restaurant/${o.restaurant.id}`}
                image={img(o.dish?.photo_url ?? o.restaurant.image)} fallback={o.dish ? '🍽️' : '🛵'}
                tag={bi('Offre', 'Deal')}
                badge={o.dish ? percentOffLabel(o.dish.regular_price, o.dish.offer_price) : bi('Livraison offerte', 'Free delivery')}
                title={o.dish?.name ?? o.restaurant.name}
                sub={o.dish ? o.restaurant.name : bi('Aujourd\'hui', 'Today')}
                icon="🏷️" line={o.dish
                  ? <>{o.restaurant.name} · <b className="text-ink-primary">{formatFCFA(o.dish.offer_price)}</b> <s>{formatAmount(o.dish.regular_price)}</s></>
                  : dot(o.restaurant.name, bi('Livraison offerte aujourd\'hui', 'Free delivery today'))}>
                {o.dish && (
                  <p className="text-[12px] mt-0.5">
                    <span className="font-bold text-brand-dark">{formatFCFA(o.dish.offer_price)}</span>{' '}
                    <span className="text-ink-tertiary line-through">{formatAmount(o.dish.regular_price)}</span>
                  </p>
                )}
              </Card>
            ))}
          </Row>
        )}

        {popular && popular.restaurants.length > 0 && (
          <Row id="popular-restaurants" title={popular.restaurantsPopular
            ? bi(`Restaurants populaires à ${city}`, `Popular restaurants in ${city}`)
            : bi(`Restaurants à ${city}`, `Restaurants in ${city}`)} more={{ href: '/restaurants', label: bi('Tout voir', 'See all') }}>
            {popular.restaurants.map(r => (
              <Card key={`r-${r.id}`} href={`/restaurant/${r.id}`} image={img(r.image_url || r.logo_url)} fallback="🍽️"
                cover={{ kind: 'restaurant', area: r.neighborhood }}
                badge={r.free_delivery ? bi('Livraison offerte', 'Free delivery') : undefined}
                title={r.name} sub={dot(cuisineText(r, locale), fulfilmentLine(r))}
                icon="🍽️" line={dot(cuisineText(r, locale), r.neighborhood, openLabel(r.id), r.delivery_enabled ? bi('Livraison', 'Delivery') : bi('À emporter', 'Take-away'))} />
            ))}
          </Row>
        )}

        {weekend.length > 0 && (
          <Row id="weekend" title={bi(`Ce week-end à ${city}`, `This weekend in ${city}`)} more={{ href: '/events', label: bi('Tout voir', 'See all') }}>
            {weekend.map(e => (
              <Card key={`w-${e.id}`} href={`/events/${e.id}`} image={img(e.cover_photo)} fallback="🎉" poster
                tag={e.category ? categoryLabel(e.category, locale) : null}
                title={e.title} sub={formatEventWhen(e, locale, 'card')}
                icon={eventCategoryIcon(e.category)}
                line={dot(e.venue, formatEventWhen(e, locale, 'card'), e.fromPrice === null ? null : e.fromPrice === 0 ? bi('Gratuit', 'Free') : `${bi('dès', 'from')} ${formatFCFA(e.fromPrice)}`)}>
                {e.fromPrice !== null && <p className="text-[12px] font-bold text-brand-dark mt-0.5">{e.fromPrice === 0 ? bi('Gratuit', 'Free') : `${bi('dès', 'from')} ${formatFCFA(e.fromPrice)}`}</p>}
              </Card>
            ))}
          </Row>
        )}

        {popular && popular.events.length > 0 && (
          <Row id="popular-events" title={popular.eventsPopular
            ? bi(`Événements populaires à ${city}`, `Popular events in ${city}`)
            : bi(`Prochains événements à ${city}`, `Upcoming events in ${city}`)} more={{ href: '/events', label: bi('Tout voir', 'See all') }}>
            {popular.events.map(e => (
              <Card key={`e-${e.id}`} href={`/events/${e.id}`} image={img(e.cover_photo)} fallback="🎉" poster
                tag={e.category ? categoryLabel(e.category, locale) : null}
                title={e.title} sub={formatEventWhen(e, locale, 'card')}
                icon={eventCategoryIcon(e.category)} line={dot(e.venue, formatEventWhen(e, locale, 'card'), eventPrice(e))}>
                <p className="text-[12px] font-bold text-brand-dark mt-0.5">{eventPrice(e)}</p>
              </Card>
            ))}
          </Row>
        )}

        {places.length > 0 && (
          <Row id="places" title={bi(`Que faire à ${city} ?`, `What to do in ${city}?`)} more={{ href: '/lieux', label: bi('Tout voir', 'See all') }}>
            {places.map(p => (
              <Card key={`p-${p.id}`} href={`/lieux/${p.id}`} image={img(p.cover_url)} fallback="🏛️" credit={p.photo_credit}
                cover={{ kind: 'place', area: p.area }} tag={placeCategoryLabel(p.category, locale)}
                title={pick(p, 'title', locale)} sub={p.area ?? ''}
                icon={placeCategory(p.category)?.icon ?? '🏛️'} line={dot(p.area, placeCategoryLabel(p.category, locale), p.price)} />
            ))}
          </Row>
        )}

        <Link href={partnerHref}
          className="mt-8 block bg-ink-primary text-white rounded-2xl p-5 hover:bg-ink-secondary transition-colors">
          <span className="block text-sm font-bold">{bi('Restaurant ou organisateur ?', 'Restaurant or organiser?')}</span>
          <span className="block text-sm opacity-90 mt-1">
            {bi('Recevez commandes et réservations sur WhatsApp, payées par Mobile Money.', 'Get orders and bookings on WhatsApp, paid by Mobile Money.')}
          </span>
          <span className="block text-sm font-bold text-brand-badge mt-2">{bi('Devenir partenaire', 'Become a partner')} →</span>
        </Link>
      </main>
    </div>
  )
}

// One horizontal row: a heading (with "Tout voir" when given) and cards that
// scroll sideways, edge to edge on a phone.
function Row({ id, title, more, children }: { id: string; title: string; more?: { href: string; label: string }; children: React.ReactNode }) {
  const { isLowData } = useDataMode()
  if (isLowData) {
    // Mode économique: a short vertical list, 5 items at most.
    return (
      <section className="mt-6" aria-labelledby={`${id}-heading`}>
        <div className="flex items-baseline justify-between gap-3 mb-2">
          <h2 id={`${id}-heading`} className="text-base font-bold text-ink-primary">{title}</h2>
          {more && <Link href={more.href} className="text-sm font-semibold text-brand-dark hover:underline flex-shrink-0">{more.label} →</Link>}
        </div>
        <div className="flex flex-col gap-2">{(Array.isArray(children) ? children : [children]).flat().slice(0, 5)}</div>
      </section>
    )
  }
  return (
    <section className="mt-8" aria-labelledby={`${id}-heading`}>
      <div className="flex items-baseline justify-between gap-3 mb-3">
        <h2 id={`${id}-heading`} className="text-base font-bold text-ink-primary">{title}</h2>
        {more && <Link href={more.href} className="text-sm font-semibold text-brand-dark hover:underline flex-shrink-0">{more.label} →</Link>}
      </div>
      <div className="flex gap-3 overflow-x-auto pb-2 -mx-4 px-4 snap-x [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {children}
      </div>
    </section>
  )
}

// A card in a row. `poster` gives events a taller, poster-shaped image.
function Card({ href, image, fallback, badge, tag, title, sub, poster, cover, credit, icon, line, children }: {
  href: string; image: string | null; fallback: string; badge?: string; tag?: string | null; title: string; sub: string; poster?: boolean
  /** I1: no image → the generated cover of this kind (with the area). */
  cover?: { kind: 'restaurant' | 'event' | 'place'; area?: string | null }
  /** The photo's credit (Lieux from Wikimedia Commons), shown on the photo. */
  credit?: string | null
  /** Mode économique row: its icon and grey line. */
  icon?: string
  line?: React.ReactNode
  children?: React.ReactNode
}) {
  const { isLowData } = useDataMode()
  if (isLowData) return <CompactRow href={href} icon={icon ?? fallback} title={title} line={line ?? sub} />
  return (
    <Link href={href} className={`snap-start flex-shrink-0 ${poster ? 'w-36' : 'w-44'} bg-white rounded-2xl border border-divider overflow-hidden shadow-sm hover:shadow-md transition-shadow`}>
      <div className={`relative ${poster ? 'h-48' : 'h-28'} bg-gradient-to-br from-brand-badge to-brand`}>
        {image
          ? <SafeImage src={image} alt="" fill sizes={poster ? '144px' : '176px'} className="object-cover"
              fallback={cover ? <GeneratedCover kind={cover.kind} title={title} area={cover.area} /> : <span className="absolute inset-0 flex items-center justify-center text-3xl" aria-hidden="true">{fallback}</span>}
              overlay={credit ? <PhotoCredit credit={credit} url={null} compact /> : null} />
          : cover ? <GeneratedCover kind={cover.kind} title={title} area={cover.area} />
          : <span className="absolute inset-0 flex items-center justify-center text-3xl" aria-hidden="true">{fallback}</span>}
        {/* U4: category pill top-left; the deal badge top-right. */}
        <CardTag label={tag} />
        {badge && (
          <span className="absolute top-2 right-2 bg-brand text-white text-[11px] font-bold px-2 py-0.5 rounded-full shadow">{badge}</span>
        )}
      </div>
      <div className="px-2.5 py-2">
        <p className="text-sm font-semibold text-ink-primary truncate">{title}</p>
        {sub && <p className="text-[11px] text-ink-tertiary truncate">{sub}</p>}
        {children}
      </div>
    </Link>
  )
}
