'use client'

export const dynamic = 'force-dynamic'

// Admin → 📊 Statistiques (admin + super admin): anonymous daily counts —
// visits per day, top 10 restaurants / events / places by views and by
// clicks (with orders / bookings over the same days), top searches.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useBi } from '@/lib/languageContext'
import { CITIES } from '@/lib/cities'

interface Item { id: string; name: string; views: number; clicks: number; byClick: Record<string, number>; conversions: number | null }
interface Data {
  days: number; from: string; to: string; totalVisits: number
  visits: Array<{ day: string; count: number }>
  tops: Record<'restaurant' | 'event' | 'place', { byViews: Item[]; byClicks: Item[] }>
  searches: Array<{ words: string; count: number }>
}
const HREF = { restaurant: '/restaurant/', event: '/events/', place: '/lieux/' }

export default function AdminStatsPage() {
  const bi = useBi()
  const [days, setDays] = useState(30)
  const [city, setCity] = useState('')
  const [data, setData] = useState<Data | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    setData(null); setError('')
    fetch(`/api/admin/stats?days=${days}${city ? `&city=${encodeURIComponent(city)}` : ''}`, { cache: 'no-store' })
      .then(async r => { const d = await r.json().catch(() => ({})); if (r.ok) setData(d); else setError(d.error ?? 'Erreur') })
      .catch(() => setError('Erreur réseau / Network error'))
  }, [days, city])

  const maxV = Math.max(1, ...(data?.visits ?? []).map(v => v.count))
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-bold text-ink-primary mr-auto">📊 {bi('Statistiques', 'Statistics')}</h2>
        {[7, 30, 90].map(d => (
          <button key={d} type="button" aria-pressed={days === d} onClick={() => setDays(d)}
            className={`px-3 py-1.5 rounded-full text-sm font-semibold border ${days === d ? 'bg-ink-primary text-white border-ink-primary' : 'bg-white border-divider text-ink-secondary'}`}>{d} {bi('j', 'd')}</button>
        ))}
        <select value={city} onChange={e => setCity(e.target.value)} className="border border-divider rounded-full px-3 py-1.5 text-sm bg-white">
          <option value="">{bi('Toutes les villes', 'All cities')}</option>
          {CITIES.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>
      <p className="text-xs text-ink-tertiary">{bi('Comptage anonyme par jour : aucun cookie, aucune adresse IP, aucun identifiant enregistré.', 'Anonymous daily counts: no cookie, IP address or identifier is stored.')}</p>
      {error && <p className="text-sm text-danger">{error}</p>}
      {!data && !error && <p className="text-sm text-ink-tertiary">…</p>}
      {data && (
        <>
          <section className="bg-white rounded-2xl shadow-sm p-4">
            <h3 className="text-sm font-bold mb-2">{bi('Visites par jour', 'Visits per day')} · <span className="font-normal">{data.totalVisits}</span></h3>
            <div className="flex items-end gap-[2px] h-28" role="img" aria-label={bi('Visites par jour', 'Visits per day')}>
              {data.visits.map(v => (
                <div key={v.day} className="flex-1 bg-brand/80 rounded-t-sm min-h-[2px]" style={{ height: `${Math.round(100 * v.count / maxV)}%` }} title={`${v.day} : ${v.count}`} />
              ))}
            </div>
            <div className="flex justify-between text-[10px] text-ink-tertiary mt-1"><span>{data.from}</span><span>{data.to}</span></div>
          </section>
          {(['restaurant', 'event', 'place'] as const).map(type => (
            <section key={type} className="bg-white rounded-2xl shadow-sm p-4">
              <h3 className="text-sm font-bold mb-2">{type === 'restaurant' ? bi('Restaurants', 'Restaurants') : type === 'event' ? bi('Événements', 'Events') : bi('Lieux', 'Places')}</h3>
              <div className="grid sm:grid-cols-2 gap-4">
                {(['byViews', 'byClicks'] as const).map(k => (
                  <div key={k}>
                    <p className="text-xs font-semibold text-ink-secondary mb-1">{k === 'byViews' ? bi('Top 10 — vues', 'Top 10 — views') : bi('Top 10 — clics', 'Top 10 — clicks')}</p>
                    {data.tops[type][k].length === 0 ? <p className="text-xs text-ink-tertiary">—</p> : (
                      <ol className="text-xs space-y-1">
                        {data.tops[type][k].map((x, i) => (
                          <li key={x.id} className="flex justify-between gap-2">
                            <Link href={`${HREF[type]}${x.id}`} target="_blank" className="truncate hover:underline">{i + 1}. {x.name}</Link>
                            <span className="flex-shrink-0 text-ink-secondary">
                              {x.views} {bi('vues', 'views')} · {x.clicks} {bi('clics', 'clicks')}
                              {x.conversions !== null && <> · {x.conversions} {type === 'restaurant' ? bi('cmd', 'orders') : bi('résa', 'bookings')}{x.views > 0 ? ` (${Math.round(100 * x.conversions / x.views)} %)` : ''}</>}
                            </span>
                          </li>
                        ))}
                      </ol>
                    )}
                  </div>
                ))}
              </div>
            </section>
          ))}
          <section className="bg-white rounded-2xl shadow-sm p-4">
            <h3 className="text-sm font-bold mb-2">🔍 {bi('Recherches les plus fréquentes', 'Top searches')}</h3>
            {data.searches.length === 0 ? <p className="text-xs text-ink-tertiary">—</p> : (
              <ol className="text-xs grid sm:grid-cols-2 gap-x-6 gap-y-1">
                {data.searches.map((q, i) => <li key={q.words} className="flex justify-between gap-2"><span className="truncate">{i + 1}. {q.words}</span><span className="font-semibold">{q.count}</span></li>)}
              </ol>
            )}
          </section>
        </>
      )}
    </div>
  )
}
