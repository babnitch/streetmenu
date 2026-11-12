'use client'
import { useRefData } from '@/lib/useRefData'

export const dynamic = 'force-dynamic'

// Admin → ⭐ À la une: per city, the ONE big card at the top of the home
// page. Pick an event, a restaurant or a place (search) with a start and an
// end date; the newest running pick wins. No running pick → the city's next
// featured event with a photo, else its next event with a photo, else no
// card (lib/homeFeatured.ts). Add / remove are audited.

import { useCallback, useEffect, useState } from 'react'
import { useBi, useLanguage } from '@/lib/languageContext'
import { useAdminCity } from '@/lib/adminCity'
import AdminCityFilter from '@/components/AdminCityFilter'
import { todayInDouala } from '@/lib/weekend'
import { FEATURED_TYPES, featuredTitle, featuredTypeLabel, type FeaturedCard, type FeaturedType } from '@/lib/homeFeatured'

interface Pick {
  id: string; item_type: FeaturedType; item_id: string; starts_on: string; ends_on: string
  name: string; live: boolean; has_photo: boolean; state: 'running' | 'upcoming' | 'ended'
}
interface Result { type: FeaturedType; id: string; name: string; sub: string | null; has_photo: boolean }

const input = 'w-full border border-divider rounded-lg px-2.5 py-2 text-sm bg-white'
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)

// The card is per city: with « Toutes » the admin picks a city first.
export default function AdminFeaturedPage() {
  const bi = useBi()
  const { city, setCity, ready, cities } = useAdminCity(bi('À la une', 'Featured'))
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-bold text-ink-primary">⭐ {bi('À la une', 'Featured')}</h2>
      <AdminCityFilter city={city} cities={cities} onChange={setCity} />
      {!ready ? <p className="text-sm text-ink-tertiary">…</p>
        : city ? <FeaturedForCity key={city} city={city} />
        : <p className="text-sm text-ink-secondary bg-white border border-divider rounded-2xl p-4">{bi('La carte « À la une » est propre à chaque ville : choisissez une ville ci-dessus.', 'The featured card is per city: pick a city above.')}</p>}
    </div>
  )
}

function FeaturedForCity({ city }: { city: string }) {
  const bi = useBi()
  useRefData()
  const { locale } = useLanguage()
  const lang = locale === 'en' ? 'en' : 'fr'
  const today = todayInDouala()
  const [data, setData] = useState<{ available: boolean; picks: Pick[]; current: FeaturedCard | null } | null>(null)
  const [type, setType] = useState<FeaturedType | ''>('')
  const [q, setQ] = useState('')
  const [results, setResults] = useState<Result[]>([])
  const [chosen, setChosen] = useState<Result | null>(null)
  const [starts, setStarts] = useState(today)
  const [ends, setEnds] = useState(addDays(today, 6))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(() => {
    setData(null)
    fetch(`/api/admin/featured?city=${encodeURIComponent(city)}`, { cache: 'no-store' })
      .then(r => r.ok ? r.json() : null)
      .then(d => setData(d ? { available: !!d.available, picks: d.picks ?? [], current: d.current ?? null } : { available: false, picks: [], current: null }))
      .catch(() => null)
  }, [city])
  useEffect(() => { load(); setChosen(null); setResults([]); setQ('') }, [load])

  // Search as the admin types (live items of the city only).
  useEffect(() => {
    if (q.trim().length < 2) { setResults([]); return }
    const t = setTimeout(() => {
      fetch(`/api/admin/featured?city=${encodeURIComponent(city)}&q=${encodeURIComponent(q.trim())}${type ? `&type=${type}` : ''}`, { cache: 'no-store' })
        .then(r => r.ok ? r.json() : { results: [] }).then(d => setResults(d.results ?? [])).catch(() => null)
    }, 250)
    return () => clearTimeout(t)
  }, [q, type, city])

  async function add() {
    if (!chosen) return
    setBusy(true); setError('')
    try {
      const res = await fetch('/api/admin/featured', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ city, item_type: chosen.type, item_id: chosen.id, starts_on: starts, ends_on: ends }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setError(d?.error ?? bi('Erreur', 'Error')); return }
      setChosen(null); setQ(''); setResults([])
      load()
    } finally { setBusy(false) }
  }

  async function remove(p: Pick) {
    if (!window.confirm(bi(`Retirer « ${p.name} » de la une ?`, `Remove "${p.name}" from featured?`))) return
    const res = await fetch(`/api/admin/featured/${p.id}`, { method: 'DELETE' })
    if (!res.ok) { const d = await res.json().catch(() => ({})); window.alert(d?.error ?? bi('Erreur', 'Error')); return }
    load()
  }

  const sourceLabel = (c: FeaturedCard) => c.source === 'pick'
    ? bi('choix admin', 'admin pick')
    : c.source === 'featured_event'
      ? bi('repli : prochain événement mis en avant avec photo', 'fallback: next featured event with a photo')
      : bi('repli : prochain événement avec photo', 'fallback: next event with a photo')
  const stateLabel = (s: Pick['state']) => s === 'running' ? bi('En cours', 'Running') : s === 'upcoming' ? bi('À venir', 'Upcoming') : bi('Terminé', 'Ended')

  return (
    <div className="space-y-4">
      <div className="bg-white border border-divider rounded-2xl p-4">
        <p className="text-xs font-semibold text-ink-tertiary uppercase">{bi('Sur l\'accueil maintenant', 'On the home page now')}</p>
        {data === null ? <p className="text-sm text-ink-tertiary mt-1">…</p>
          : data.current ? (
            <p className="text-sm mt-1">
              <b>{featuredTitle(data.current, lang)}</b> · {featuredTypeLabel(data.current.type, lang)} · <span className="text-ink-secondary">{sourceLabel(data.current)}</span>
              {!data.current.image && <span className="text-amber-700"> · {bi('sans photo', 'no photo')}</span>}
            </p>
          ) : <p className="text-sm text-ink-secondary mt-1">{bi('Aucune carte (pas de choix, pas d\'événement avec photo).', 'No card (no pick, no event with a photo).')}</p>}
      </div>

      {data && !data.available && (
        <p className="text-sm bg-amber-50 border border-amber-200 text-amber-800 rounded-xl px-3 py-2">
          {bi('Choix pas encore disponibles : lancez supabase-home-featured.sql. L\'accueil utilise le repli.', 'Picks not available yet: run supabase-home-featured.sql. The home page uses the fallback.')}
        </p>
      )}

      {data?.available && (
        <div className="bg-white border border-divider rounded-2xl p-4 space-y-3">
          <p className="text-sm font-bold text-ink-primary">{bi('Ajouter un choix', 'Add a pick')}</p>
          <div className="flex gap-2 flex-wrap">
            {(['', ...FEATURED_TYPES] as const).map(t => (
              <button key={t || 'all'} type="button" onClick={() => setType(t)}
                className={`px-3 py-1.5 rounded-full text-xs font-semibold border ${type === t ? 'bg-ink-primary text-white border-ink-primary' : 'bg-white text-ink-secondary border-divider'}`}>
                {t ? featuredTypeLabel(t, lang) : bi('Tout', 'All')}
              </button>
            ))}
          </div>
          <input value={q} onChange={e => { setQ(e.target.value); setChosen(null) }} className={input}
            placeholder={bi(`Rechercher à ${city} (événement, restaurant, lieu)…`, `Search in ${city} (event, restaurant, place)…`)} />
          {!chosen && results.length > 0 && (
            <ul className="border border-divider rounded-xl divide-y divide-divider max-h-64 overflow-y-auto">
              {results.map(r => (
                <li key={`${r.type}-${r.id}`}>
                  <button type="button" onClick={() => setChosen(r)} className="w-full text-left px-3 py-2 text-sm hover:bg-surface-muted">
                    <b>{r.name}</b> <span className="text-ink-tertiary">· {featuredTypeLabel(r.type, lang)}{r.sub ? ` · ${r.sub}` : ''}</span>
                    {!r.has_photo && <span className="text-amber-700"> · {bi('sans photo', 'no photo')}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {chosen && (
            <p className="text-sm bg-surface-muted rounded-xl px-3 py-2">
              ✓ <b>{chosen.name}</b> · {featuredTypeLabel(chosen.type, lang)}
              {!chosen.has_photo && <span className="text-amber-700"> · {bi('sans photo : la carte s\'affichera sans image', 'no photo: the card will show without an image')}</span>}
            </p>
          )}
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs text-ink-secondary">{bi('Début', 'Start')}
              <input type="date" value={starts} min={today} onChange={e => setStarts(e.target.value)} className={input} />
            </label>
            <label className="text-xs text-ink-secondary">{bi('Fin', 'End')}
              <input type="date" value={ends} min={starts} onChange={e => setEnds(e.target.value)} className={input} />
            </label>
          </div>
          {error && <p className="text-sm text-rose-600">{error}</p>}
          <button type="button" onClick={add} disabled={!chosen || busy}
            className="bg-brand hover:bg-brand-dark disabled:opacity-50 text-white px-4 py-2 rounded-full text-sm font-bold">
            {busy ? '…' : bi('Mettre à la une', 'Feature it')}
          </button>
          <p className="text-xs text-ink-tertiary">
            {bi('Si plusieurs choix tombent le même jour, le plus récent gagne. Un événement terminé disparaît tout seul.',
                'If several picks cover the same day, the newest wins. An event that is over disappears by itself.')}
          </p>
        </div>
      )}

      {data?.available && data.picks.length > 0 && (
        <ul className="bg-white border border-divider rounded-2xl divide-y divide-divider">
          {data.picks.map(p => (
            <li key={p.id} className="px-4 py-3 flex items-center justify-between gap-3">
              <div className="min-w-0 text-sm">
                <p className="font-semibold text-ink-primary truncate">{p.name}</p>
                <p className="text-xs text-ink-tertiary">
                  {featuredTypeLabel(p.item_type, lang)} · {p.starts_on} → {p.ends_on} · {stateLabel(p.state)}
                  {!p.live && p.state !== 'ended' && <span className="text-rose-600"> · {bi('plus en ligne (ignoré)', 'no longer live (skipped)')}</span>}
                </p>
              </div>
              <button type="button" onClick={() => remove(p)} className="flex-shrink-0 text-xs font-semibold text-rose-600 hover:underline">
                {bi('Retirer', 'Remove')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
