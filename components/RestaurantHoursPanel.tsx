'use client'

// Public hours card on the restaurant detail page. Renders the week's
// schedule (collapsed into ranges via lib/openingHours.formatHoursForDisplay)
// and a one-line status that flips between
// "Ouvert · ferme à 22:00" and "Fermé · ouvre à 08:00".

import { useEffect, useState } from 'react'
import { useLanguage, useBi } from '@/lib/languageContext'
import {
  formatHoursForDisplay,
  type RestaurantHourRow,
} from '@/lib/openingHours'

interface BulkStatus {
  open:      boolean
  source:    string
  next_kind?: 'opens' | 'closes' | string
  next_at?:  string
  next_day?: number
}

export default function RestaurantHoursPanel({ restaurantId }: { restaurantId: string }) {
  const bi = useBi()
  const { locale } = useLanguage()
  const [hours, setHours] = useState<RestaurantHourRow[]>([])
  const [status, setStatus] = useState<BulkStatus | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const [hRes, sRes] = await Promise.all([
          fetch(`/api/restaurants/${restaurantId}/hours`,         { cache: 'no-store' }).then(r => r.json()),
          fetch(`/api/restaurants/open-status?ids=${restaurantId}`, { cache: 'no-store' }).then(r => r.json()),
        ])
        if (cancelled) return
        setHours(Array.isArray(hRes?.hours) ? hRes.hours : [])
        setStatus(sRes?.status?.[restaurantId] ?? null)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [restaurantId])

  if (loading) {
    // Skeleton card — keeps the surface visible while the schedule fetch
    // resolves. Returning null caused the panel to silently appear later
    // and was easy to miss on a slow mobile network.
    return (
      <div className="bg-white rounded-2xl p-4 shadow-sm">
        <h2 className="text-base font-bold text-ink-primary mb-2">
          🕐 {bi('Horaires', 'Opening hours')}
        </h2>
        <p className="text-xs text-ink-tertiary">…</p>
      </div>
    )
  }
  if (hours.length === 0) return null  // restaurant has no schedule yet — don't render an empty card

  const lines = formatHoursForDisplay(hours, locale === 'fr' ? 'fr' : 'en')
  const todayDow = new Date().getDay()
  const todayRow = hours.find(h => h.day_of_week === todayDow)
  const todayLine = todayRow
    ? (todayRow.is_closed
        ? bi('Aujourd\'hui: fermé', 'Today: closed')
        : bi(
            `Aujourd'hui: ${todayRow.open_time.slice(0, 5)} – ${todayRow.close_time.slice(0, 5)}`,
            `Today: ${todayRow.open_time.slice(0, 5)} – ${todayRow.close_time.slice(0, 5)}`,
          ))
    : null

  return (
    <div className="bg-white rounded-2xl p-4 shadow-sm">
      <h2 className="text-base font-bold text-ink-primary mb-2">
        🕐 {bi('Horaires', 'Opening hours')}
      </h2>

      {status && (
        <div className={`text-sm font-semibold mb-3 ${
          status.open ? 'text-emerald-700' : 'text-rose-700'
        }`}>
          {status.open
            ? bi('🟢 Ouvert', '🟢 Open')
            : bi('🔴 Fermé', '🔴 Closed')}
          {status.next_kind && status.next_at && (
            <span className="text-xs font-normal text-ink-tertiary ml-2">
              · {status.next_kind === 'opens'
                ? bi(`ouvre à ${status.next_at}`,  `opens at ${status.next_at}`)
                : bi(`ferme à ${status.next_at}`, `closes at ${status.next_at}`)}
            </span>
          )}
        </div>
      )}

      {todayLine && (
        <p className="text-xs text-brand-darker bg-brand-light rounded-lg px-2 py-1 inline-block mb-2">
          {todayLine}
        </p>
      )}

      <ul className="space-y-0.5 text-xs text-ink-secondary">
        {lines.map((l, i) => <li key={i}>{l}</li>)}
      </ul>
    </div>
  )
}
