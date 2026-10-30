'use client'
import { cuisineText } from '@/lib/cuisineCategories'

import { track } from '@/lib/track'
export const dynamic = 'force-dynamic'

import { LINK_FIELDS, LINK_LABELS } from '@/lib/restaurantLinks'
import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import dynamicImport from 'next/dynamic'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { Restaurant } from '@/types'
import { useBi, useLanguage } from '@/lib/languageContext'
import { formatPrepTime } from '@/lib/prepTime'
import { formatDeliveryTime } from '@/lib/delivery'
import { formatFCFA } from '@/lib/money'
import { deliversNow } from '@/lib/modules'
import TopNav from '@/components/TopNav'
import RestaurantHoursPanel from '@/components/RestaurantHoursPanel'
import RestaurantRatingPanel from '@/components/RestaurantRatingPanel'

const Map = dynamicImport(() => import('@/components/Map'), { ssr: false })

// /restaurant/[id]/info — "Infos du restaurant" (V4), opened from the ⋯ menu:
//   map with the pin · name · type · "4,6 ★ (N avis)" · address + Itinéraire ·
//   hours · delivery (fee, time) or take-away only · WhatsApp contact ·
//   ratings and "Donner mon avis" (#rate, the bot's rating link lands here).
export default function RestaurantInfoPage() {
  const bi = useBi()
  const { locale } = useLanguage()
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const [r, setR] = useState<Restaurant | null>(null)
  const [rating, setRating] = useState<{ average: number; count: number } | null>(null)
  const [freeDelivery, setFreeDelivery] = useState(false)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const [{ data }, ratingRes, offersRes] = await Promise.all([
        supabase.from('restaurants').select('*').eq('id', id).maybeSingle(),
        fetch(`/api/restaurants/${id}/rating`, { cache: 'no-store' }).then(x => x.ok ? x.json() : null).catch(() => null),
        fetch(`/api/offers/today?restaurant_id=${id}`, { cache: 'no-store' }).then(x => x.ok ? x.json() : null).catch(() => null),
      ])
      if (cancelled) return
      setR(data as Restaurant | null)
      if (ratingRes && typeof ratingRes.count === 'number') setRating({ average: Number(ratingRes.average ?? 0), count: ratingRes.count })
      setFreeDelivery(offersRes?.free_delivery === true)
      setLoaded(true)
    })()
    return () => { cancelled = true }
  }, [id])

  if (!loaded) {
    return <div className="min-h-screen bg-surface"><TopNav /><p className="text-center text-ink-tertiary mt-16">…</p></div>
  }
  if (!r || r.deleted_at || r.status === 'deleted' || r.status === 'suspended') {
    return (
      <div className="min-h-screen bg-surface">
        <TopNav />
        <div className="text-center mt-16">
          <p className="text-ink-secondary mb-4">{bi('Restaurant introuvable', 'Restaurant not found')}</p>
          <Link href="/restaurants" className="text-brand-dark underline">{bi('Retour', 'Back')}</Link>
        </div>
      </div>
    )
  }

  const hasPin = Number.isFinite(r.lat) && Number.isFinite(r.lng) && !(r.lat === 0 && r.lng === 0)
  const address = [r.address, r.neighborhood, r.city].filter(Boolean).join(', ')
  const directions = hasPin
    ? `https://www.google.com/maps/dir/?api=1&destination=${r.lat},${r.lng}`
    : `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address)}`
  const whatsapp = (r.whatsapp ?? '').replace(/\D/g, '')
  const avg = rating ? rating.average.toLocaleString(locale === 'fr' ? 'fr-FR' : 'en-GB', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : ''
  const fee = freeDelivery ? 0 : Number(r.delivery_fee ?? 0)
  const deliveryTime = formatDeliveryTime(r.prep_time_min, r.prep_time_max, r.delivery_extra_min)
  const prepTime = formatPrepTime(r.prep_time_min, r.prep_time_max)

  return (
    <div className="min-h-screen bg-surface">
      <TopNav />
      <div className="max-w-2xl mx-auto pb-28 md:pb-12">
        <div className="px-4 py-3 flex items-center gap-3">
          <button onClick={() => router.back()} aria-label={bi('Retour', 'Back')}
            className="w-9 h-9 rounded-full bg-surface-muted flex items-center justify-center text-ink-secondary hover:bg-divider transition-colors">
            ←
          </button>
          <h1 className="text-lg font-bold text-ink-primary">{bi('Infos du restaurant', 'Restaurant info')}</h1>
        </div>

        {hasPin && (
          <div className="h-48 md:h-64 md:mx-4 md:rounded-2xl overflow-hidden">
            <Map restaurants={[{ id: r.id, name: r.name, lat: r.lat, lng: r.lng, is_open: true }]}
              onSelectRestaurant={() => {}} selectedId={r.id} center={[r.lng, r.lat]} zoom={15} />
          </div>
        )}

        <div className="px-4">
          <h2 className="text-2xl font-black text-ink-primary mt-4">{r.name}</h2>
          {cuisineText(r, locale) && <p className="text-sm text-ink-secondary">{cuisineText(r, locale)}</p>}
          {rating && rating.count > 0 && (
            <a href="#rate" className="inline-block mt-1 text-sm font-semibold text-ink-primary">
              {avg} ★ <span className="font-normal text-ink-tertiary">({rating.count} {bi('avis', rating.count === 1 ? 'review' : 'reviews')})</span>
            </a>
          )}

          <ul className="mt-4 divide-y divide-divider border-y border-divider">
            <Row icon="📍">
              <div className="flex items-start justify-between gap-3">
                <span className="text-sm text-ink-primary">{address || '—'}</span>
                <a href={directions} target="_blank" rel="noopener noreferrer" onClick={() => track('click_directions', 'restaurant', r.id, r.city)}
                  className="flex-shrink-0 text-sm font-semibold text-brand-dark hover:underline">
                  {bi('Itinéraire', 'Directions')}
                </a>
              </div>
            </Row>
            <Row icon={deliversNow(r) ? '🛵' : '🥡'}>
              {deliversNow(r) ? (
                <span className="text-sm text-ink-primary">
                  {bi('Livraison', 'Delivery')} {fee > 0 ? formatFCFA(fee) : bi('offerte', 'free')}
                  {deliveryTime ? ` · ${deliveryTime}` : ''}
                  <span className="block text-xs text-ink-tertiary">
                    {bi('À emporter aussi', 'Take-away too')}{prepTime ? ` · ${prepTime}` : ''}
                  </span>
                </span>
              ) : (
                <span className="text-sm text-ink-primary">
                  {bi('À emporter uniquement', 'Take-away only')}{prepTime ? ` · ${prepTime}` : ''}
                </span>
              )}
            </Row>
            {whatsapp && (
              <Row icon="💬">
                <a href={`https://wa.me/${whatsapp}`} target="_blank" rel="noopener noreferrer" onClick={() => track('click_whatsapp', 'restaurant', r.id, r.city)}
                  className="text-sm font-semibold text-emerald-700 hover:underline">
                  {bi('Contacter sur WhatsApp', 'Contact on WhatsApp')}
                </a>
              </Row>
            )}
            {/* I2: the restaurant's links. */}
            {LINK_FIELDS.some(f => !!r[f]) && (
              <Row icon="🔗">
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  {LINK_FIELDS.filter(f => !!r[f]).map(f => (
                    <a key={f} href={r[f]!} target="_blank" rel="noopener noreferrer" className="text-sm font-semibold text-brand-dark hover:underline">
                      {LINK_LABELS[f].icon} {bi(LINK_LABELS[f].fr, LINK_LABELS[f].en)}
                    </a>
                  ))}
                </div>
              </Row>
            )}
          </ul>

          <div className="mt-4">
            <RestaurantHoursPanel restaurantId={id} />
          </div>

          <div id="rate" className="mt-3 scroll-mt-20">
            <RestaurantRatingPanel restaurantId={id} />
          </div>

          <Link href={`/restaurant/${id}`}
            className="mt-6 block text-center bg-brand hover:bg-brand-dark text-white py-3 rounded-full font-semibold transition-colors">
            {bi('Voir le menu', 'See the menu')}
          </Link>
        </div>
      </div>
    </div>
  )
}

function Row({ icon, children }: { icon: string; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-3 py-3">
      <span aria-hidden="true" className="w-6 text-center">{icon}</span>
      <div className="flex-1 min-w-0">{children}</div>
    </li>
  )
}
