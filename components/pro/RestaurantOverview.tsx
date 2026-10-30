'use client'

// Restaurant dashboard → 📊 Aperçu (owner + manager): today · 7 days · 30
// days. Figures from /api/restaurants/[id]/overview (server-side, Africa/
// Douala time).

import { useEffect, useState } from 'react'
import { useBi } from '@/lib/languageContext'
import { formatFCFA } from '@/lib/money'

type Period = 'today' | '7d' | '30d'
interface Overview {
  orders: number; revenue: number; online: number; onSite: number; average: number; cancelled: number
  delivery: number; pickup: number; topDishes: Array<{ name: string; quantity: number }>
  hours: Array<{ hour: number; orders: number }>; views: number; clicks: Record<string, number>
}

const CLICK_LABELS: Record<string, [string, string]> = {
  click_whatsapp: ['WhatsApp', 'WhatsApp'], click_call: ['Appeler', 'Call'], click_directions: ['Itinéraire', 'Directions'], click_map: ['Voir la carte', 'See the menu'],
}

export default function RestaurantOverview({ restaurantId }: { restaurantId: string }) {
  const bi = useBi()
  const [period, setPeriod] = useState<Period>('today')
  const [data, setData] = useState<Overview | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let live = true
    setData(null); setError('')
    fetch(`/api/restaurants/${restaurantId}/overview?period=${period}`, { cache: 'no-store' })
      .then(async r => { const d = await r.json().catch(() => ({})); if (!live) return; if (!r.ok) setError(d.error ?? 'Erreur'); else setData(d) })
      .catch(() => live && setError(bi('Erreur réseau', 'Network error')))
    return () => { live = false }
  }, [restaurantId, period, bi])

  const maxHour = Math.max(1, ...(data?.hours ?? []).map(h => h.orders))
  return (
    <div className="space-y-4">
      <div className="inline-flex bg-surface-muted rounded-xl p-1 text-sm font-semibold" role="tablist">
        {([['today', bi("Aujourd'hui", 'Today')], ['7d', bi('7 jours', '7 days')], ['30d', bi('30 jours', '30 days')]] as const).map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={period === k} onClick={() => setPeriod(k)}
            className={`px-3.5 py-1.5 rounded-lg ${period === k ? 'bg-white shadow-sm text-ink-primary' : 'text-ink-secondary'}`}>{label}</button>
        ))}
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
      {!data && !error && <p className="text-sm text-ink-tertiary">…</p>}
      {data && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <Stat label={bi('Commandes', 'Orders')} value={String(data.orders)} />
            <Stat label={bi("Chiffre d'affaires", 'Revenue')} value={formatFCFA(data.revenue)} strong />
            <Stat label={bi('Panier moyen', 'Average order')} value={formatFCFA(data.average)} />
            <Stat label={bi('Annulées', 'Cancelled')} value={String(data.cancelled)} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Stat label={bi('Payé en ligne', 'Paid online')} value={formatFCFA(data.online)} />
            <Stat label={bi('Payé sur place', 'Paid on site')} value={formatFCFA(data.onSite)} />
            <Stat label={bi('Livraison', 'Delivery')} value={String(data.delivery)} />
            <Stat label={bi('À emporter', 'Take-away')} value={String(data.pickup)} />
          </div>
          <section className="bg-white rounded-2xl border border-divider p-4">
            <h3 className="text-sm font-bold text-ink-primary mb-2">🍽️ {bi('Top 5 des plats', 'Top 5 dishes')}</h3>
            {data.topDishes.length === 0 ? <p className="text-xs text-ink-tertiary">{bi('Pas encore de commande.', 'No orders yet.')}</p> : (
              <ol className="text-sm space-y-1">
                {data.topDishes.map((d, i) => <li key={d.name} className="flex justify-between gap-2"><span className="truncate">{i + 1}. {d.name}</span><span className="font-semibold">× {d.quantity}</span></li>)}
              </ol>
            )}
          </section>
          <section className="bg-white rounded-2xl border border-divider p-4">
            <h3 className="text-sm font-bold text-ink-primary mb-2">🕐 {bi('Heures les plus chargées', 'Busiest hours')}</h3>
            {data.hours.length === 0 ? <p className="text-xs text-ink-tertiary">—</p> : (
              <ul className="space-y-1.5">
                {data.hours.slice(0, 8).map(h => (
                  <li key={h.hour} className="flex items-center gap-2 text-xs">
                    <span className="w-12 flex-shrink-0 font-mono">{String(h.hour).padStart(2, '0')}h</span>
                    <span className="flex-1 bg-surface-muted rounded-full h-3 overflow-hidden"><span className="block h-full bg-brand rounded-full" style={{ width: `${Math.round(100 * h.orders / maxHour)}%` }} /></span>
                    <span className="w-6 text-right font-semibold">{h.orders}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="bg-white rounded-2xl border border-divider p-4">
            <h3 className="text-sm font-bold text-ink-primary mb-2">👀 {bi('Visites de votre page', 'Visits to your page')}</h3>
            <p className="text-sm"><strong>{data.views}</strong> {bi('vues', 'views')}</p>
            <ul className="mt-1 text-xs text-ink-secondary flex flex-wrap gap-x-4 gap-y-1">
              {Object.entries(CLICK_LABELS).map(([k, [fr, en]]) => <li key={k}>{bi(fr, en)} : <strong>{data.clicks[k] ?? 0}</strong></li>)}
            </ul>
            <p className="mt-2 text-[11px] text-ink-tertiary">{bi('Comptage anonyme, sans cookie.', 'Anonymous counting, no cookies.')}</p>
          </section>
        </>
      )}
    </div>
  )
}

function Stat({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`rounded-xl p-3 ${strong ? 'bg-brand text-white' : 'bg-white border border-divider'}`}>
      <p className={`text-[11px] ${strong ? 'text-white/85' : 'text-ink-tertiary'}`}>{label}</p>
      <p className="text-base font-bold mt-0.5">{value}</p>
    </div>
  )
}
