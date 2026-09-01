'use client'

import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { Restaurant } from '@/types'
import { useBi } from '@/lib/languageContext'
import { useDataMode } from '@/lib/dataMode'
import { formatPrepTime } from '@/lib/prepTime'

// Feed card for a restaurant. Two layouts share one component:
//
//   < md  — Uber Eats-style 2-column grid tile: image, name, cuisine,
//           ⭐ rating · 🕐 prep, and a "Fermé" chip over the image.
//   ≥ md  — the original desktop card (location line, cuisine pill,
//           open/closed badge on the right). Unchanged on purpose: the
//           redesign is mobile-only.
//
// Extracted from app/page.tsx so the search overlay renders identical
// cards without duplicating the promo-tracking / low-data logic.

export interface RatingSummary { average: number; count: number }

export default function RestaurantCard({
  restaurant, rating, openOverride, promotionId,
}: {
  restaurant: Restaurant
  rating?: RatingSummary
  // Server-computed open status from /api/restaurants/open-status. Wins
  // over the legacy restaurants.is_open column (which can drift while
  // the schedule cron isn't a thing). Undefined while the bulk endpoint
  // hasn't responded yet — we fall back to is_open during that gap.
  openOverride?: boolean
  // When set, this card is a paid promotion. We render a subtle
  // Sponsorisé / Sponsored label and fire impression + click tracking.
  promotionId?: string
}) {
  const bi = useBi()
  const { isLowData } = useDataMode()
  const [imgError, setImgError] = useState(false)
  const cardRef = useRef<HTMLAnchorElement>(null)

  // Impression tracking — fires once when the card enters the viewport.
  // Client-side dedupe (1h per promotion) lives in promoTracking.
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

  const isOpen = openOverride ?? restaurant.is_open
  const neighborhood = restaurant.neighborhood || restaurant.address
  const location = [neighborhood, restaurant.city].filter(Boolean).join(', ')
  const cuisine = restaurant.cuisine_type || restaurant.description
  const prepLabel = formatPrepTime(restaurant.prep_time_min, restaurant.prep_time_max)
  const initial = (restaurant.name?.[0] ?? '?').toUpperCase()
  const heroImage = restaurant.image_url || restaurant.logo_url
  // Low-data mode: skip the image regardless of whether one exists, so
  // the user's bandwidth budget stays predictable. The gradient + initial
  // fallback already shipped as the empty-image state — we reuse it.
  const showImage = !isLowData && heroImage && !imgError

  return (
    <Link
      ref={cardRef}
      href={`/restaurant/${restaurant.id}`}
      onClick={() => {
        if (promotionId) {
          import('@/lib/promoTracking').then(m => m.fireClick(promotionId))
        }
      }}
      className="group block bg-surface rounded-xl overflow-hidden shadow-sm md:shadow-none md:border md:border-divider hover:shadow-card transition-shadow"
    >
      <div className="relative aspect-[16/9] overflow-hidden bg-surface-muted">
        {showImage ? (
          <Image
            src={heroImage!}
            alt={restaurant.name}
            fill
            onError={() => setImgError(true)}
            className="object-cover transition-transform duration-300 group-hover:scale-[1.02]"
            sizes="(max-width: 767px) 50vw, (max-width: 1024px) 50vw, 33vw"
          />
        ) : (
          <div className="absolute inset-0 bg-gradient-to-br from-brand-light via-brand-badge to-brand flex items-center justify-center">
            <span className="text-white text-4xl md:text-5xl font-black tracking-tight drop-shadow-sm">
              {initial}
            </span>
          </div>
        )}
        {/* Closed chip — mobile only. The desktop card keeps its
            open/closed badge in the text block below. */}
        {!isOpen && (
          <span className="md:hidden absolute top-2 left-2 bg-black/70 text-white text-[10px] font-semibold px-2 py-1 rounded-full leading-none">
            {bi('Fermé', 'Closed')}
          </span>
        )}
      </div>

      {/* ── Mobile layout (< md) ─────────────────────────────────────── */}
      <div className="md:hidden p-2.5">
        <p className="font-bold text-ink-primary text-sm leading-tight truncate">
          {restaurant.name}
        </p>
        {cuisine && (
          <p className="text-xs text-ink-secondary mt-0.5 truncate">{cuisine}</p>
        )}
        <div className="mt-1 flex items-center gap-2 text-xs text-ink-secondary">
          {rating && rating.count > 0 && (
            <span className="font-semibold text-ink-primary whitespace-nowrap">
              ⭐ {rating.average.toFixed(1)}
              <span className="text-ink-tertiary font-normal"> ({rating.count})</span>
            </span>
          )}
          {prepLabel && (
            <span className="whitespace-nowrap truncate">🕐 {prepLabel}</span>
          )}
        </div>
        {promotionId && (
          <p className="text-[10px] text-ink-tertiary mt-1 leading-none">
            {bi('Sponsorisé', 'Sponsored')}
          </p>
        )}
      </div>

      {/* ── Desktop layout (md+) — unchanged from the pre-redesign card ─ */}
      <div className="hidden md:flex p-3 items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="font-bold text-brand-dark text-base leading-tight line-clamp-1">
            {restaurant.name}
          </p>
          {location && (
            <p className="text-sm text-brand-dark mt-0.5 line-clamp-1">
              {location}
            </p>
          )}
          {prepLabel && (
            <p className="text-xs text-ink-secondary mt-1">
              🕐 {prepLabel}
            </p>
          )}
          {cuisine && (
            <span className="inline-block mt-2 bg-brand-light text-brand-darker text-xs font-semibold px-2 py-0.5 rounded-full border border-brand-badge/60">
              {cuisine}
            </span>
          )}
          {promotionId && (
            <p className="text-[10px] text-ink-tertiary mt-1.5 leading-none">
              {bi('Sponsorisé', 'Sponsored')}
            </p>
          )}
          {rating && rating.count > 0 && (
            <p className="mt-1.5 text-xs text-amber-700 font-semibold">
              ⭐ {rating.average.toFixed(1)} <span className="text-ink-tertiary font-normal">({rating.count})</span>
            </p>
          )}
        </div>
        <span className={`flex-shrink-0 text-xs font-semibold whitespace-nowrap ${
          isOpen ? 'text-green-600' : 'text-red-600'
        }`}>
          {isOpen ? bi('🟢 Ouvert', '🟢 Open') : bi('🔴 Fermé', '🔴 Closed')}
        </span>
      </div>
    </Link>
  )
}

export function RestaurantCardSkeleton() {
  return (
    <div className="bg-surface rounded-xl overflow-hidden shadow-sm md:shadow-none md:border md:border-divider">
      <div className="aspect-[16/9] skeleton rounded-none" />
      <div className="p-2.5 md:p-3 space-y-2">
        <div className="skeleton h-4 w-3/4" />
        <div className="skeleton h-3 w-1/2" />
      </div>
    </div>
  )
}
