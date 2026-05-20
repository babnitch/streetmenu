'use client'

import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { useBi } from '@/lib/languageContext'
import { fireImpression, fireClick } from '@/lib/promoTracking'

interface Promo {
  id:           string
  target_type:  'restaurant' | 'event'
  target_id:    string
  placement:    string
}

interface BannerContent {
  promotionId: string
  href:        string
  title:       string
  subtitle:    string
  imageUrl:    string | null
}

// Single banner ad rendered between sections on the restaurant detail
// page. Fetches active banner-placement promotions for the given city
// (excluding the viewer's own promos via the API's session-aware
// filter), resolves the target's display fields, and renders one
// subtle card. Max 1 per page — the first eligible promotion wins.
//
// If no banner promotion exists for the city, the component renders
// nothing — keeps the layout stable.
export default function BannerAd({ city }: { city: string | null | undefined }) {
  const bi = useBi()
  const [content, setContent] = useState<BannerContent | null>(null)
  const rootRef = useRef<HTMLAnchorElement>(null)

  useEffect(() => {
    if (!city) return
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(
          `/api/promotions/active?city=${encodeURIComponent(city)}&type=restaurant&placement=banner`,
          { cache: 'no-store' },
        )
        const d = await res.json()
        const promos: Promo[] = Array.isArray(d?.promotions) ? d.promotions : []
        if (promos.length === 0) {
          // Try event banners too — both types share the same placement
          const r2 = await fetch(
            `/api/promotions/active?city=${encodeURIComponent(city)}&type=event&placement=banner`,
            { cache: 'no-store' },
          )
          const d2 = await r2.json()
          const evPromos: Promo[] = Array.isArray(d2?.promotions) ? d2.promotions : []
          if (evPromos.length === 0) return
          await resolveAndSet(evPromos[0], 'event')
          return
        }
        await resolveAndSet(promos[0], 'restaurant')
      } catch { /* silent — no banner */ }

      async function resolveAndSet(p: Promo, type: 'restaurant' | 'event') {
        try {
          if (type === 'restaurant') {
            const { supabase } = await import('@/lib/supabase')
            const { data } = await supabase
              .from('restaurants')
              .select('name, cuisine_type, image_url, logo_url')
              .eq('id', p.target_id).maybeSingle()
            if (cancelled || !data) return
            setContent({
              promotionId: p.id,
              href:        `/restaurant/${p.target_id}`,
              title:       data.name,
              subtitle:    data.cuisine_type ?? '',
              imageUrl:    data.image_url || data.logo_url || null,
            })
          } else {
            const { supabase } = await import('@/lib/supabase')
            const { data } = await supabase
              .from('events')
              .select('title, venue, cover_photo, category')
              .eq('id', p.target_id).maybeSingle()
            if (cancelled || !data) return
            setContent({
              promotionId: p.id,
              href:        `/events/${p.target_id}`,
              title:       data.title,
              subtitle:    data.venue ?? data.category ?? '',
              imageUrl:    data.cover_photo || null,
            })
          }
        } catch { /* silent */ }
      }
    })()
    return () => { cancelled = true }
  }, [city])

  // Impression once the banner enters the viewport.
  useEffect(() => {
    if (!content) return
    if (typeof IntersectionObserver === 'undefined') return
    const el = rootRef.current
    if (!el) return
    const io = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          fireImpression(content.promotionId)
          io.disconnect()
          break
        }
      }
    }, { threshold: 0.5 })
    io.observe(el)
    return () => io.disconnect()
  }, [content])

  if (!content) return null

  return (
    <Link
      ref={rootRef}
      href={content.href}
      onClick={() => fireClick(content.promotionId)}
      className="block bg-white rounded-2xl shadow-sm border border-divider overflow-hidden hover:shadow-card transition-shadow"
    >
      <div className="flex items-center gap-3 p-3">
        {content.imageUrl ? (
          <div className="relative w-16 h-16 rounded-xl overflow-hidden flex-shrink-0 bg-surface-muted">
            <Image src={content.imageUrl} alt={content.title} fill className="object-cover" sizes="64px" />
          </div>
        ) : (
          <div className="w-16 h-16 rounded-xl bg-brand-light flex items-center justify-center flex-shrink-0 text-2xl">
            📢
          </div>
        )}
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-ink-primary text-sm truncate">{content.title}</p>
          {content.subtitle && (
            <p className="text-xs text-ink-tertiary truncate mt-0.5">{content.subtitle}</p>
          )}
          <p className="text-[10px] text-ink-tertiary mt-1 leading-none">
            {bi('Sponsorisé', 'Sponsored')}
          </p>
        </div>
        <span className="flex-shrink-0 text-xs font-semibold text-brand-dark bg-brand-light px-3 py-1.5 rounded-full">
          {bi('Voir', 'See')}
        </span>
      </div>
    </Link>
  )
}
