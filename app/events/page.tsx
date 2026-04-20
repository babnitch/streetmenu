'use client'

export const dynamic = 'force-dynamic'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { supabase } from '@/lib/supabase'
import { Event } from '@/types'
import { useLanguage } from '@/lib/languageContext'
import TopNav from '@/components/TopNav'

const CITIES = ['Yaoundé', 'Abidjan', 'Dakar', 'Lomé']

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
  const [events, setEvents] = useState<Event[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedCity, setSelectedCity] = useState('Yaoundé')
  const [selectedCategory, setSelectedCategory] = useState('all')

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

  const filtered = events.filter(e => {
    const cityMatch = e.city === selectedCity
    const catMatch = selectedCategory === 'all' || e.category === selectedCategory
    return cityMatch && catMatch
  })

  return (
    <div className="min-h-screen bg-surface">

      <TopNav cta={{ label: t('evt.submitBtn'), href: '/events/submit' }} />

      {/* City pills */}
      <div className="bg-white border-b border-divider">
        <div className="max-w-5xl mx-auto px-4 py-3 flex gap-2 overflow-x-auto scrollbar-hide">
          {CITIES.map(city => (
            <button
              key={city}
              onClick={() => setSelectedCity(city)}
              className={`flex-shrink-0 px-4 py-1.5 rounded-full text-sm font-semibold transition-colors ${
                selectedCity === city
                  ? 'bg-brand text-white shadow-sm'
                  : 'bg-brand-light text-ink-secondary hover:bg-brand-light'
              }`}
            >
              {city}
            </button>
          ))}
        </div>
      </div>

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
              {cat}
            </button>
          ))}
        </div>
      </div>

      {/* Main */}
      <main className="max-w-5xl mx-auto px-4 py-5 pb-32">

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

    </div>
  )
}
