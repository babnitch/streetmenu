'use client'

import { useEffect, useRef } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { Event } from '@/types'
import { useBi, useLanguage } from '@/lib/languageContext'
import { useDataMode } from '@/lib/dataMode'
import { formatEventWhen, formatEventDay, isMultiDay } from '@/lib/eventDate'

// Seat status of the card's day, from GET /api/events/availability.
export interface CardDayStatus { soldOut: boolean; otherDaysAvailable: boolean }

// The event card on the Events tab. A promoted card (promotionId set) fires
// an impression once it is half on screen and a click when opened.
//
// bookingDay is the calendar day the card is shown for. A multi-day event's
// link carries it (?date=) so its page books that day; dayStatus marks the
// card "Épuisé" when that day is full.
export default function EventCard({ event, viewLabel, freeLabel, categoryDisplay, likes, promotionId, tierPrices, isPast, bookingDay, today, dayStatus }: { event: Event; viewLabel: string; freeLabel: string; categoryDisplay: string; likes?: number; promotionId?: string; tierPrices?: number[]; isPast?: boolean; bookingDay?: string | null; today?: string | null; dayStatus?: CardDayStatus }) {
  const bi = useBi()
  const { locale } = useLanguage()
  const { isLowData } = useDataMode()
  const whenStr = formatEventWhen(event, locale, 'card')
  const multiDay = isMultiDay(event)
  const href = multiDay && bookingDay ? `/events/${event.id}?date=${bookingDay}` : `/events/${event.id}`
  const soldOutLabel = !isPast && dayStatus?.soldOut
    ? (bookingDay && bookingDay !== today
        ? `${bi('Épuisé le', 'Sold out on')} ${formatEventDay(bookingDay, locale, 'compact')}`
        : bi("Épuisé aujourd'hui", 'Sold out today'))
    : null
  const cardRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!promotionId) return
    if (typeof IntersectionObserver === 'undefined') return
    const el = cardRef.current
    if (!el) return
    const io = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          import('@/lib/promoTracking').then(m => m.fireImpression(promotionId))
          io.disconnect()
          break
        }
      }
    }, { threshold: 0.5 })
    io.observe(el)
    return () => io.disconnect()
  }, [promotionId])

  return (
    <div ref={cardRef} className={`bg-white rounded-2xl overflow-hidden shadow-sm hover:shadow-md transition-shadow border border-brand-light ${isPast ? 'opacity-60 grayscale' : ''}`}>
      <div className="relative h-36 bg-gradient-to-br from-brand-badge to-brand">
        {event.cover_photo && !isLowData ? (
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
          {categoryDisplay}
        </span>
        {isPast && (
          <span className="absolute bottom-2 left-2 bg-ink-primary text-white text-[10px] font-bold px-2 py-0.5 rounded-full">
            ⏳ {bi('Passé', 'Past')}
          </span>
        )}
        {(() => {
          // Three branches: (1) no tiers → single price as before;
          // (2) tiers exist → range/all-free/mixed; (3) free fallback.
          if (tierPrices && tierPrices.length > 0) {
            const paid = tierPrices.filter(p => p > 0)
            if (paid.length === 0) {
              return (
                <span className="absolute top-2 right-2 bg-brand text-white text-xs font-bold px-2 py-0.5 rounded-full">
                  {freeLabel}
                </span>
              )
            }
            const min = Math.min(...paid)
            const max = Math.max(...paid)
            const hasFree = tierPrices.some(p => p === 0)
            const label = min === max
              ? `${min.toLocaleString()} FCFA`
              : `${min.toLocaleString()} - ${max.toLocaleString()} FCFA`
            const prefix = hasFree ? `${freeLabel} - ` : ''
            return (
              <span className="absolute top-2 right-2 bg-black/50 text-white text-xs font-bold px-2 py-0.5 rounded-full backdrop-blur-sm">
                {prefix}{label}
              </span>
            )
          }
          if (event.price === null || event.price === 0) {
            return (
              <span className="absolute top-2 right-2 bg-brand text-white text-xs font-bold px-2 py-0.5 rounded-full">
                {freeLabel}
              </span>
            )
          }
          return (
            <span className="absolute top-2 right-2 bg-black/50 text-white text-xs font-bold px-2 py-0.5 rounded-full backdrop-blur-sm">
              {Number(event.price).toLocaleString()} FCFA
            </span>
          )
        })()}
      </div>

      <div className="px-3 pt-3 pb-3">
        <p className="font-bold text-ink-primary text-sm leading-tight line-clamp-2 mb-1">
          {event.title}
        </p>
        <p className="text-xs text-brand font-medium mb-0.5">📅 {whenStr}</p>
        {event.venue && (
          <p className="text-xs text-ink-tertiary truncate">📍 {event.venue}{event.neighborhood ? `, ${event.neighborhood}` : ''}</p>
        )}
        {event.reservations_open === false && (
          <p className="text-[10px] text-ink-tertiary font-semibold mt-1 leading-none">
            🔒 {bi('Réservations fermées', 'Reservations closed')}
          </p>
        )}
        {likes && likes > 0 ? (
          <p className="text-xs text-rose-600 font-semibold mt-1">❤️ {likes}</p>
        ) : null}
        {promotionId && (
          <p className="text-[10px] text-ink-tertiary mt-1 leading-none">
            {bi('Sponsorisé', 'Sponsored')}
          </p>
        )}
        {soldOutLabel && (
          <div className="mt-2 leading-tight">
            <p className="text-[11px] font-bold text-rose-700">🔴 {soldOutLabel}</p>
            {multiDay && dayStatus?.otherDaysAvailable && (
              <p className="text-[10px] text-ink-tertiary">{bi('Autres dates disponibles', 'Other dates available')}</p>
            )}
          </div>
        )}
        <Link
          href={href}
          onClick={() => {
            if (promotionId) import('@/lib/promoTracking').then(m => m.fireClick(promotionId))
          }}
          className="mt-2.5 block w-full bg-brand hover:bg-brand-dark text-white text-center py-1.5 rounded-xl text-xs font-semibold transition-colors"
        >
          {viewLabel}
        </Link>
      </div>
    </div>
  )
}

export function EventCardSkeleton() {
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
