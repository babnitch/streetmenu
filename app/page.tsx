'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import TopNav from '@/components/TopNav'
import CityDropdown from '@/components/CityDropdown'
import SearchOverlay from '@/components/SearchOverlay'
import { useBi, useLanguage } from '@/lib/languageContext'
import { useCity } from '@/lib/cityContext'
import { useMode } from '@/lib/modeContext'
import { useDataMode } from '@/lib/dataMode'
import { proLoginHref } from '@/lib/lastPhone'
import { formatEventWhen, type EventWhen } from '@/lib/eventDate'

const BOT_NUMBER = (process.env.NEXT_PUBLIC_WHATSAPP_BOT_NUMBER ?? '').replace(/\D/g, '')

interface PopularRestaurant { id: string; name: string; cuisine_type: string | null; neighborhood: string | null; image_url: string | null; logo_url: string | null }
interface PopularEvent extends EventWhen { id: string; title: string; category: string | null; venue: string | null; cover_photo: string | null }

// / — the landing page (L4), for everyone. The restaurant list moved to
// /restaurants; old /?q= links are forwarded there.
//   promise · city chip · one search (dishes, restaurants, events) ·
//   "Manger" / "Sortir" · WhatsApp (when a bot number is set) ·
//   "Populaires à [ville]" (hidden when empty) · partner banner.
export default function HomePage() {
  const bi = useBi()
  const { locale } = useLanguage()
  const { city } = useCity()
  const { sessionRole, loading: modeLoading } = useMode()
  const { isLowData } = useDataMode()
  const [searchOpen, setSearchOpen] = useState(false)
  const [popular, setPopular] = useState<{ restaurants: PopularRestaurant[]; events: PopularEvent[] } | null>(null)

  // Old links: /?q=… was the restaurant search.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get('q')
    if (q) window.location.replace(`/restaurants?q=${encodeURIComponent(q)}#search`)
  }, [])

  useEffect(() => {
    let cancelled = false
    setPopular(null)
    fetch(`/api/popular?city=${encodeURIComponent(city)}`, { cache: 'no-store' })
      .then(r => r.json())
      .then(d => { if (!cancelled) setPopular({ restaurants: d?.restaurants ?? [], events: d?.events ?? [] }) })
      .catch(() => { if (!cancelled) setPopular({ restaurants: [], events: [] }) })
    return () => { cancelled = true }
  }, [city])

  const partnerHref = !modeLoading && sessionRole ? '/pro' : proLoginHref('/pro')
  const hasPopular = !!popular && (popular.restaurants.length > 0 || popular.events.length > 0)

  return (
    <div className="min-h-screen bg-surface">
      <TopNav />
      <SearchOverlay open={searchOpen} onClose={() => setSearchOpen(false)} desktop />

      <main className="max-w-2xl mx-auto px-4 pt-6 pb-28 md:pb-12">
        <h1 className="text-2xl md:text-3xl font-black text-ink-primary leading-tight">
          {bi('Commandez à manger et réservez vos sorties', 'Order food and book outings')}
        </h1>

        <div className="mt-4"><CityDropdown /></div>

        <button type="button" onClick={() => setSearchOpen(true)}
          className="mt-4 w-full flex items-center gap-3 bg-white border border-divider rounded-2xl px-4 py-3.5 text-left shadow-sm hover:border-brand transition-colors">
          <span aria-hidden="true" className="text-lg">🔍</span>
          <span className="text-sm text-ink-tertiary">{bi('Un plat, un restaurant, un événement…', 'A dish, a restaurant, an event…')}</span>
        </button>

        <div className="mt-4 grid grid-cols-2 gap-3">
          <Link href="/restaurants" className="bg-brand hover:bg-brand-dark text-white rounded-2xl p-5 shadow-sm transition-colors">
            <span className="block text-3xl mb-1" aria-hidden="true">🍽️</span>
            <span className="block text-lg font-bold">{bi('Manger', 'Eat')}</span>
            <span className="block text-xs opacity-90">{bi('Restaurants', 'Restaurants')}</span>
          </Link>
          <Link href="/events" className="bg-ink-primary hover:bg-ink-secondary text-white rounded-2xl p-5 shadow-sm transition-colors">
            <span className="block text-3xl mb-1" aria-hidden="true">🎉</span>
            <span className="block text-lg font-bold">{bi('Sortir', 'Go out')}</span>
            <span className="block text-xs opacity-90">{bi('Événements', 'Events')}</span>
          </Link>
        </div>

        {BOT_NUMBER && (
          <a href={`https://wa.me/${BOT_NUMBER}?text=menu`} target="_blank" rel="noopener noreferrer"
            className="mt-3 block text-center text-sm font-semibold text-emerald-700 hover:underline">
            💬 {bi('Ou commandez directement sur WhatsApp', 'Or order directly on WhatsApp')}
          </a>
        )}

        {/* Populaires — never an empty section. */}
        {hasPopular && (
          <section className="mt-8" aria-labelledby="popular-heading">
            <h2 id="popular-heading" className="text-base font-bold text-ink-primary mb-3">
              ⭐ {bi(`Populaires à ${city}`, `Popular in ${city}`)}
            </h2>
            <div className="flex gap-3 overflow-x-auto pb-2 -mx-4 px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {popular!.restaurants.map(r => (
                <PopularCard key={`r-${r.id}`} href={`/restaurant/${r.id}`} image={isLowData ? null : (r.image_url || r.logo_url)}
                  fallback="🍽️" title={r.name} sub={[r.cuisine_type, r.neighborhood].filter(Boolean).join(' · ')} />
              ))}
              {popular!.events.map(e => (
                <PopularCard key={`e-${e.id}`} href={`/events/${e.id}`} image={isLowData ? null : e.cover_photo}
                  fallback="🎉" title={e.title} sub={formatEventWhen(e, locale, 'card')} />
              ))}
            </div>
          </section>
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

function PopularCard({ href, image, fallback, title, sub }: { href: string; image: string | null; fallback: string; title: string; sub: string }) {
  return (
    <Link href={href} className="flex-shrink-0 w-40 bg-white rounded-2xl border border-divider overflow-hidden shadow-sm hover:shadow-md transition-shadow">
      <div className="relative h-24 bg-gradient-to-br from-brand-badge to-brand">
        {image
          ? <Image src={image} alt="" fill sizes="160px" className="object-cover" />
          : <span className="absolute inset-0 flex items-center justify-center text-3xl" aria-hidden="true">{fallback}</span>}
      </div>
      <div className="px-2.5 py-2">
        <p className="text-sm font-semibold text-ink-primary truncate">{title}</p>
        {sub && <p className="text-[11px] text-ink-tertiary truncate">{sub}</p>}
      </div>
    </Link>
  )
}
